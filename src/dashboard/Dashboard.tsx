import React, { useState, useEffect, useRef } from 'react';
import {
  Video,
  Settings,
  FileText,
  RefreshCw,
  Trash2,
  Play,
  ChevronLeft,
  X,
  Minus,
  Square,
  Download,
  Pencil,
  Check,
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Recording {
  id: number;
  title: string;
  date: string;
  duration: number;
  filePath: string;
  status: 'idle' | 'transcribing' | 'analyzing' | 'completed';
  transcript?: string;
  summary?: string;
  actionItems?: string[];
}

import { processRecording } from '../utils/ai';

// ── API layer: uses Electron IPC when available, HTTP REST API otherwise ───
const SERVER_PORT = 5201;
const ipc = (window as any).electronAPI;

const httpApi = {
  getRecordings: async (): Promise<Recording[]> => {
    try {
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/recordings`);
      if (!res.ok) return [];
      return res.json();
    } catch { return []; }
  },
  updateRecording: async ({ id, fields }: { id: number; fields: any }) => {
    await fetch(`http://127.0.0.1:${SERVER_PORT}/api/recordings/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    return true;
  },
  deleteRecording: async (id: number) => {
    await fetch(`http://127.0.0.1:${SERVER_PORT}/api/recordings/${id}`, { method: 'DELETE' });
    return true;
  },
  downloadRecording: async (id: number) => {
    const a = document.createElement('a');
    a.href = `http://127.0.0.1:${SERVER_PORT}/api/recordings/${id}/file`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return { success: true };
  },
  minimizeApp: () => {},
  maximizeApp: () => {},
  closeApp: () => {},
};

const api = ipc ?? httpApi;
// ──────────────────────────────────────────────────────────────────────────

function formatDuration(s: number) {
  if (typeof s !== 'number' || isNaN(s)) return '00:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function getVideoUrl(filePath: string): string {
  const filename = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  return `http://127.0.0.1:${SERVER_PORT}/${encodeURIComponent(filename)}`;
}

const Dashboard: React.FC = () => {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [openaiKey, setOpenaiKey] = useState(localStorage.getItem('openai_key') || '');
  const [videoError, setVideoError] = useState<string | null>(null);

  // ── Recording state ────────────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [recTimer, setRecTimer] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  const formatRecTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const startRecording = async () => {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1920, height: 1080, frameRate: 30 } as MediaTrackConstraints,
        audio: true,
      });

      let finalStream: MediaStream = displayStream;
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        if (displayStream.getAudioTracks().length > 0) ctx.createMediaStreamSource(displayStream).connect(dest);
        ctx.createMediaStreamSource(micStream).connect(dest);
        finalStream = new MediaStream([...displayStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      } catch { /* mic unavailable */ }

      displayStream.getVideoTracks()[0].onended = () => stopRecording();
      streamRef.current = finalStream;

      const mimeType =
        MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2') ? 'video/mp4;codecs=avc1,mp4a.40.2' :
        MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' :
        MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' :
        'video/webm';

      const sessionId = await (window as any).electronAPI?.initRecording(mimeType);
      sessionIdRef.current = sessionId;

      const mr = new MediaRecorder(finalStream, { mimeType });
      mr.ondataavailable = async (e) => {
        if (e.data.size > 0 && sessionIdRef.current) {
          try {
            const buf = await e.data.arrayBuffer();
            await (window as any).electronAPI?.appendChunk(sessionIdRef.current, buf);
          } catch {}
        }
      };
      mr.onstop = async () => {
        if (timerRef.current) clearInterval(timerRef.current);
        setIsRecording(false);
        setRecTimer(0);
        try {
          await (window as any).electronAPI?.finalizeRecording({
            sessionId: sessionIdRef.current,
            title: `Recording ${new Date().toLocaleString()}`,
            duration: durationRef.current,
          });
          sessionIdRef.current = null;
          await loadRecordings();
        } catch {}
      };

      mediaRecorderRef.current = mr;
      mr.start(1000);

      const startTime = Date.now();
      durationRef.current = 0;
      setRecTimer(0);
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        durationRef.current = elapsed;
        setRecTimer(elapsed);
      }, 1000);

      setIsRecording(true);
    } catch (err: any) {
      alert('Could not start recording: ' + (err.message || err));
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  };
  // ──────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    setVideoError(null);
  }, [selectedRecording?.id]);

  // Rename state
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const loadRecordings = async () => {
    const data = await api.getRecordings();
    setRecordings(data);
    if (selectedRecording) {
      const updated = data.find((r: Recording) => r.id === selectedRecording.id);
      if (updated) setSelectedRecording(updated);
    }
  };

  useEffect(() => {
    loadRecordings();
    const interval = setInterval(loadRecordings, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (renamingId !== null && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const startRename = (rec: Recording, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingId(rec.id);
    setRenameValue(rec.title);
  };

  const commitRename = async (id: number) => {
    const title = renameValue.trim();
    if (title) {
      await api.updateRecording({ id, fields: { title } });
      await loadRecordings();
      if (selectedRecording?.id === id) {
        setSelectedRecording((prev) => prev ? { ...prev, title } : null);
      }
    }
    setRenamingId(null);
  };

  const handleDelete = async (id: number) => {
    if (confirm('Delete this recording?')) {
      await api.deleteRecording(id);
      await loadRecordings();
      if (selectedRecording?.id === id) setSelectedRecording(null);
    }
  };

  const handleDownload = async (id: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      const result = await api.downloadRecording(id);
      if (result?.error) alert('Download failed: ' + result.error);
    } catch (err: any) {
      alert('Download failed: ' + err.message);
    }
  };

  const handleProcessMeeting = async (rec: Recording) => {
    if (!openaiKey) {
      alert('Please set your OpenAI API key in Settings first.');
      setIsSettingsOpen(true);
      return;
    }
    setIsProcessing(true);
    try {
      await processRecording(rec.id, rec.filePath, openaiKey);
      await loadRecordings();
    } catch (err: any) {
      alert('AI Processing failed: ' + err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex h-screen bg-white text-slate-900 overflow-hidden font-sans">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-100 flex flex-col bg-slate-50/50">
        <div className="p-6 flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Video className="text-white w-5 h-5" />
          </div>
          <span className="font-outfit font-bold text-xl tracking-tight">FocusRec</span>
        </div>

        <nav className="flex-1 px-4 space-y-1">
          <button
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white shadow-sm border border-slate-200 text-blue-600 font-medium"
            onClick={() => setSelectedRecording(null)}
          >
            <Video className="w-4 h-4" />
            All Recordings
          </button>
          <button className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-100 text-slate-600 transition-colors">
            <FileText className="w-4 h-4" />
            Meeting Notes
          </button>
          <button
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-100 text-slate-600 transition-colors"
            onClick={() => setIsSettingsOpen(true)}
          >
            <Settings className="w-4 h-4" />
            Settings
          </button>
        </nav>

        <div className="p-6 border-t border-slate-100">
          <div className="bg-blue-50 rounded-2xl p-4">
            <p className="text-xs text-blue-600 font-semibold uppercase tracking-wider mb-1">Storage</p>
            <p className="text-xs text-blue-700 leading-relaxed">
              {recordings.length} / 100 recordings saved locally.
            </p>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Header */}
        <header
          className="h-16 border-b border-slate-100 flex items-center justify-between px-8 bg-white/80 backdrop-blur-md sticky top-0 z-10"
          style={{ WebkitAppRegion: ipc ? 'drag' : 'no-drag' } as React.CSSProperties}
        >
          <div className="flex items-center gap-4">
            {selectedRecording && (
              <button
                onClick={() => setSelectedRecording(null)}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <ChevronLeft className="w-5 h-5 text-slate-500" />
              </button>
            )}
            {selectedRecording && renamingId === selectedRecording.id ? (
              <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(selectedRecording.id);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => commitRename(selectedRecording.id)}
                  className="font-outfit font-bold text-lg border-b-2 border-blue-500 outline-none bg-transparent"
                />
                <button onClick={() => commitRename(selectedRecording.id)} className="p-1 text-green-600">
                  <Check className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="font-outfit font-bold text-lg">
                  {selectedRecording ? selectedRecording.title : 'My Recordings'}
                </h1>
                {selectedRecording && (
                  <button
                    onClick={(e) => startRename(selectedRecording, e)}
                    className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600"
                    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    title="Rename"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Record button + Window controls */}
          <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {isRecording ? (
              <button
                onClick={stopRecording}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white font-bold text-sm rounded-xl animate-pulse-red"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                {formatRecTime(recTimer)} — Stop
              </button>
            ) : (
              <button
                onClick={startRecording}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold text-sm rounded-xl transition-colors"
              >
                <Video className="w-3.5 h-3.5" />
                Record
              </button>
            )}
            {ipc && (
              <>
                <button onClick={() => api.minimizeApp()} className="p-2 hover:bg-slate-100 rounded-lg"><Minus className="w-4 h-4 text-slate-400" /></button>
                <button onClick={() => api.maximizeApp()} className="p-2 hover:bg-slate-100 rounded-lg"><Square className="w-4 h-4 text-slate-400" /></button>
                <button onClick={() => api.closeApp()} className="p-2 hover:bg-red-50 hover:text-red-600 rounded-lg"><X className="w-4 h-4 text-slate-400" /></button>
              </>
            )}
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-8">
          {!selectedRecording ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {recordings.length === 0 ? (
                <div className="col-span-full py-20 flex flex-col items-center justify-center text-slate-400">
                  <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                    <Video className="w-8 h-8" />
                  </div>
                  <h3 className="text-lg font-medium text-slate-600">No recordings yet</h3>
                  <p className="text-sm">
                    {ipc ? 'Start a recording from the floating widget!' : 'Make sure the FocusRec app is running, then refresh.'}
                  </p>
                </div>
              ) : (
                recordings.map((rec) => (
                  <div
                    key={rec.id}
                    className="group bg-white border border-slate-200 rounded-2xl p-5 hover:shadow-xl hover:border-blue-200 transition-all cursor-pointer relative"
                    onClick={() => setSelectedRecording(rec)}
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center group-hover:bg-blue-600 group-hover:text-white transition-colors">
                        <Play className="w-5 h-5 fill-current" />
                      </div>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-2 py-1 bg-slate-50 rounded-md">
                        {formatDuration(rec.duration)}
                      </span>
                    </div>

                    {renamingId === rec.id ? (
                      <div className="mb-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(rec.id);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          onBlur={() => commitRename(rec.id)}
                          className="font-semibold text-slate-800 w-full border-b border-blue-500 outline-none bg-transparent"
                        />
                      </div>
                    ) : (
                      <h3 className="font-semibold text-slate-800 mb-1 truncate">{rec.title}</h3>
                    )}

                    <p className="text-xs text-slate-500 mb-4">
                      {new Date(rec.date).toLocaleDateString()} at {new Date(rec.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>

                    <div className="flex items-center justify-between">
                      <span className={cn(
                        'text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-tight',
                        rec.status === 'completed' ? 'bg-green-50 text-green-600' : 'bg-blue-50 text-blue-600'
                      )}>
                        {rec.status === 'completed' ? 'AI Processed' : 'Ready'}
                      </span>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => startRename(rec, e)}
                          className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600"
                          title="Rename"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => handleDownload(rec.id, e)}
                          className="p-1.5 hover:bg-blue-50 rounded-lg text-slate-400 hover:text-blue-600"
                          title="Download"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(rec.id); }}
                          className="p-1.5 hover:bg-red-50 rounded-lg text-slate-400 hover:text-red-500"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="aspect-video bg-slate-900 rounded-3xl overflow-hidden shadow-2xl relative group flex items-center justify-center">
                {videoError ? (
                  <div className="flex flex-col items-center gap-3 text-center px-8">
                    <span className="text-red-400 text-sm font-semibold">Failed to load video</span>
                    <span className="text-slate-500 text-xs">{videoError}</span>
                  </div>
                ) : (
                  <video
                    key={selectedRecording.id}
                    src={getVideoUrl(selectedRecording.filePath)}
                    controls
                    autoPlay={false}
                    preload="metadata"
                    className="w-full h-full object-contain"
                    onError={(e) => {
                      const err = (e.target as HTMLVideoElement).error;
                      setVideoError(err?.message || 'Unknown playback error');
                      console.error('[video] error:', err);
                    }}
                  />
                )}
              </div>

              {/* Actions row */}
              <div className="flex gap-3">
                <button
                  onClick={() => handleDownload(selectedRecording.id)}
                  className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white font-semibold text-sm rounded-xl hover:bg-blue-700 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download to Downloads Folder
                </button>
                <button
                  onClick={(e) => startRename(selectedRecording, e)}
                  className="flex items-center gap-2 px-5 py-2.5 bg-slate-100 text-slate-700 font-semibold text-sm rounded-xl hover:bg-slate-200 transition-colors"
                >
                  <Pencil className="w-4 h-4" />
                  Rename
                </button>
                <button
                  onClick={() => handleDelete(selectedRecording.id)}
                  className="flex items-center gap-2 px-5 py-2.5 bg-red-50 text-red-500 font-semibold text-sm rounded-xl hover:bg-red-100 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                <div className="md:col-span-2 space-y-8">
                  <section className="bg-white border border-slate-100 rounded-3xl p-8 shadow-sm">
                    <div className="flex items-center justify-between mb-6">
                      <h2 className="font-outfit font-bold text-xl flex items-center gap-2">
                        <FileText className="w-5 h-5 text-blue-600" />
                        Meeting Summary
                      </h2>
                      <button
                        disabled={isProcessing}
                        onClick={() => handleProcessMeeting(selectedRecording)}
                        className={cn(
                          'text-xs font-bold text-blue-600 hover:underline uppercase tracking-widest flex items-center gap-2',
                          isProcessing && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        {isProcessing ? (
                          <><RefreshCw className="w-3 h-3 animate-spin" />Processing...</>
                        ) : selectedRecording.status === 'completed' ? 'Re-Analyze' : 'Analyze with AI'}
                      </button>
                    </div>
                    <div className="prose prose-slate max-w-none">
                      {selectedRecording.summary ? (
                        <p className="text-slate-600 leading-relaxed text-lg">{selectedRecording.summary}</p>
                      ) : (
                        <div className="py-8 text-center text-slate-400 italic">
                          Summary will appear here after AI processing.
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="bg-white border border-slate-100 rounded-3xl p-8 shadow-sm">
                    <h2 className="font-outfit font-bold text-xl mb-6 flex items-center gap-2">
                      <FileText className="w-5 h-5 text-blue-600" />
                      Transcript
                    </h2>
                    <div className="max-h-96 overflow-y-auto pr-4 space-y-4">
                      {selectedRecording.transcript ? (
                        <p className="text-sm text-slate-600 whitespace-pre-wrap leading-relaxed">{selectedRecording.transcript}</p>
                      ) : (
                        <div className="py-8 text-center text-slate-400 italic">No transcript available.</div>
                      )}
                    </div>
                  </section>
                </div>

                <div className="space-y-8">
                  <section className="bg-slate-50 rounded-3xl p-8 border border-slate-100">
                    <h2 className="font-outfit font-bold text-lg mb-4">Action Items</h2>
                    {selectedRecording.actionItems?.length ? (
                      <ul className="space-y-3">
                        {selectedRecording.actionItems.map((item, i) => (
                          <li key={i} className="flex gap-3 text-sm text-slate-600">
                            <div className="w-5 h-5 rounded-md border border-slate-300 flex-shrink-0 mt-0.5" />
                            {item}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-slate-400 italic">No action items found.</p>
                    )}
                  </section>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-md p-8 animate-in zoom-in-95 duration-300">
            <div className="flex justify-between items-center mb-8">
              <h2 className="font-outfit font-extrabold text-2xl">Settings</h2>
              <button onClick={() => setIsSettingsOpen(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-6">
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase tracking-widest block mb-2">OpenAI API Key</label>
                <input
                  type="password"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all placeholder:text-slate-400"
                />
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                  Used for Transcription (Whisper) and Analysis (GPT-4). Stored locally on this device only.
                </p>
              </div>
              <button
                onClick={() => { localStorage.setItem('openai_key', openaiKey); setIsSettingsOpen(false); }}
                className="w-full py-4 bg-blue-600 text-white font-bold rounded-2xl shadow-lg shadow-blue-200 hover:bg-blue-700 transition-all"
              >
                Save Configuration
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
