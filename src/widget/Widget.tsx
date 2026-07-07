import React, { useState, useRef } from 'react';
import { Square, GripVertical, Video, Maximize2 } from 'lucide-react';

const Widget: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [timer, setTimer] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const startRecording = async () => {
    try {
      // getDisplayMedia is intercepted by main.ts setDisplayMediaRequestHandler
      // — auto selects primary screen + loopback (system audio), NO dialog shown
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1920, height: 1080, frameRate: 30 } as MediaTrackConstraints,
        audio: true,
      });

      let finalStream: MediaStream = displayStream;

      // Mix in microphone audio on top of system audio
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        if (displayStream.getAudioTracks().length > 0) {
          ctx.createMediaStreamSource(displayStream).connect(dest);
        }
        ctx.createMediaStreamSource(micStream).connect(dest);
        finalStream = new MediaStream([
          ...displayStream.getVideoTracks(),
          ...dest.stream.getAudioTracks(),
        ]);
      } catch {
        // mic unavailable — use display stream as-is (system audio only)
      }

      // If user stops sharing from OS UI, auto-stop the recording
      displayStream.getVideoTracks()[0].onended = () => stopRecording();

      streamRef.current = finalStream;

      const mimeType =
        MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2') ? 'video/mp4;codecs=avc1,mp4a.40.2' :
        MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' :
        MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' :
        'video/webm';

      // Open a streaming session on disk before recording starts
      const sessionId = await (window as any).electronAPI?.initRecording(mimeType);
      sessionIdRef.current = sessionId;

      const mr = new MediaRecorder(finalStream, { mimeType });
      mr.ondataavailable = async (e) => {
        if (e.data.size > 0 && sessionIdRef.current) {
          try {
            const buf = await e.data.arrayBuffer();
            await (window as any).electronAPI?.appendChunk(sessionIdRef.current, buf);
          } catch (chunkErr) {
            console.error('Failed to write chunk:', chunkErr);
          }
        }
      };
      mr.onstop = async () => {
        // Always reset UI immediately — don't wait for save
        if (timerRef.current) clearInterval(timerRef.current);
        setIsRecording(false);
        setTimer(0);
        // Finalize — log error but don't crash the widget
        try {
          await (window as any).electronAPI?.finalizeRecording({
            sessionId: sessionIdRef.current,
            title: `Recording ${new Date().toLocaleString()}`,
            duration: durationRef.current,
          });
          sessionIdRef.current = null;
          (window as any).electronAPI?.recordingStopped();
        } catch (saveErr) {
          console.error('Failed to finalize recording:', saveErr);
        }
      };

      mediaRecorderRef.current = mr;
      mr.start(1000);

      // Start timer
      const startTime = Date.now();
      durationRef.current = 0;
      setTimer(0);
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        durationRef.current = elapsed;
        setTimer(elapsed);
      }, 1000);

      setIsRecording(true);
      // Non-fatal — just notifies dashboard, doesn't affect recording
      try { (window as any).electronAPI?.recordingStarted(); } catch {}
    } catch (err: any) {
      console.error('Recording failed:', err);
      // Only show alert for actual recording failures, not electronAPI issues
      if (err.name !== 'TypeError') {
        alert('Could not start recording: ' + err.message);
      }
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        gap: 10,
        borderRadius: 999,
        background: isRecording ? 'rgba(220,38,38,0.93)' : 'rgba(15,23,42,0.93)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        border: '1px solid rgba(255,255,255,0.12)',
        userSelect: 'none',
        WebkitAppRegion: 'drag',
        transition: 'background 0.3s',
      } as React.CSSProperties}
    >
      {/* Drag grip */}
      <GripVertical style={{ width: 14, height: 14, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }} />

      {/* Interactive zone — must be no-drag */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {isRecording ? (
          <>
            {/* Pulsing red dot */}
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'white',
                display: 'inline-block',
                animation: 'recpulse 1.2s ease-in-out infinite',
              }}
            />
            {/* Timer */}
            <span
              style={{
                fontFamily: 'monospace',
                fontSize: 13,
                fontWeight: 700,
                color: 'white',
                letterSpacing: 2,
                minWidth: 44,
              }}
            >
              {formatTime(timer)}
            </span>
            {/* Stop button */}
            <button
              onClick={stopRecording}
              title="Stop recording"
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: 'white',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Square style={{ width: 12, height: 12, fill: '#dc2626', color: '#dc2626' }} />
            </button>
          </>
        ) : (
          <>
            {/* Record button */}
            <button
              onClick={startRecording}
              title="Start recording"
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#dc2626',
                border: '2px solid rgba(255,255,255,0.4)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Video style={{ width: 14, height: 14, color: 'white' }} />
            </button>
            {/* Open dashboard */}
            <button
              onClick={() => (window as any).electronAPI.openDashboard()}
              title="Open recordings"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Maximize2 style={{ width: 13, height: 13, color: 'rgba(255,255,255,0.55)' }} />
            </button>
          </>
        )}
      </div>

      {/* Pulse keyframe injected inline */}
      <style>{`
        @keyframes recpulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>
    </div>
  );
};

export default Widget;
