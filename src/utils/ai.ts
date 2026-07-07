import OpenAI from 'openai';

export const processRecording = async (recordingId: number, filePath: string, openaiKey: string) => {
  const openai = new OpenAI({ 
    apiKey: openaiKey,
    dangerouslyAllowBrowser: true 
  });

  try {
    // 1. Transcribe
    const file = await fetch(`file://${filePath.replace(/\\/g, '/')}`);
    const blob = await file.blob();
    const transcription = await openai.audio.transcriptions.create({
      file: new File([blob], "recording.webm", { type: "video/webm" }),
      model: "whisper-1",
    });

    // 2. Analyze
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a professional meeting assistant. Analyze the transcript and provide a 2-3 sentence summary and a list of clear action items. Return JSON format: { \"summary\": \"...\", \"actionItems\": [\"...\", \"...\"] }"
        },
        {
          role: "user",
          content: `Transcript: ${transcription.text}`
        }
      ],
      response_format: { type: "json_object" }
    });

    const analysis = JSON.parse(response.choices[0].message.content || '{}');

    // 3. Update DB
    await (window as any).electronAPI.updateRecording({
      id: recordingId,
      fields: {
        transcript: transcription.text,
        summary: analysis.summary,
        actionItems: analysis.actionItems,
        status: 'completed'
      }
    });

    return true;
  } catch (err) {
    console.error("AI Error:", err);
    await (window as any).electronAPI.updateRecording({
      id: recordingId,
      fields: { status: 'idle' }
    });
    throw err;
  }
};
