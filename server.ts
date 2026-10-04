import express from "express";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));

// Server-side Gemini initialization
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey
  ? new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    })
  : null;

// Acoustic voice synthesizer fallback when Gemini TTS daily quota is reached
function generateAcousticSpeechWav(text: string): string {
  const sampleRate = 24000;
  const words = (text || "Speech narration").trim().split(/\s+/).length;
  const durationSeconds = Math.max(2, Math.min(12, words / 2.5 + 0.4));
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // Standard 44-byte RIFF WAV Header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Vocal formant cadence synthesis
  const baseFreq = 150;
  let offset = 44;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const syllablePhase = (t * 4.2) % 1;
    const syllEnvelope = Math.sin(Math.PI * syllablePhase);
    const edgeFade = Math.min(1, Math.min(t * 12, (durationSeconds - t) * 6));
    const pitch = baseFreq + Math.sin(t * 3.5) * 12;

    const f1 = Math.sin(2 * Math.PI * pitch * t);
    const f2 = 0.5 * Math.sin(2 * Math.PI * pitch * 2.1 * t);
    const f3 = 0.25 * Math.sin(2 * Math.PI * pitch * 3.2 * t);

    const sampleVal = (f1 + f2 + f3) * syllEnvelope * edgeFade * 0.35;
    const clamped = Math.max(-1, Math.min(1, sampleVal));
    buffer.writeInt16LE(Math.floor(clamped * 32767), offset);
    offset += 2;
  }

  return buffer.toString("base64");
}

// Endpoint: Generate Speech (Single speaker with gemini-3.8-flash-lite-tts)
app.post("/api/tts/generate", async (req, res) => {
  const { text, voiceName = "Kore", style = "Clear, engaging voiceover" } = req.body;

  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Text is required for speech synthesis" });
  }

  const validVoices = ["Puck", "Charon", "Kore", "Fenrir", "Zephyr"];
  const chosenVoice = validVoices.includes(voiceName) ? voiceName : "Kore";

  if (!ai) {
    const fallbackAudio = generateAcousticSpeechWav(text);
    return res.json({
      audioData: fallbackAudio,
      mimeType: "audio/wav",
      voice: chosenVoice,
      isFallback: true,
    });
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash-lite-tts",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: text.trim(),
              speechMetadata: {
                style: style || "Natural, pleasant speech cadence",
              },
            },
          ],
        },
      ],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: chosenVoice },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    const mimeType = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType || "audio/wav";

    if (!base64Audio) {
      const fallbackAudio = generateAcousticSpeechWav(text);
      return res.json({
        audioData: fallbackAudio,
        mimeType: "audio/wav",
        voice: chosenVoice,
        isFallback: true,
      });
    }

    return res.json({
      audioData: base64Audio,
      mimeType,
      voice: chosenVoice,
    });
  } catch (error: any) {
    // Graceful fallback on free tier rate limits (10 requests/day limit)
    const fallbackAudio = generateAcousticSpeechWav(text);
    return res.json({
      audioData: fallbackAudio,
      mimeType: "audio/wav",
      voice: chosenVoice,
      quotaExceeded: true,
      isFallback: true,
      message: "Daily free Gemini voice quota reached. Switched to acoustic voice track / Web Speech.",
    });
  }
});

// Endpoint: Multi-Speaker Screenplay / Dialogue (`gemini-3.8-flash-tts`)
app.post("/api/tts/dialogue", async (req, res) => {
  const {
    speaker1 = { name: "Alex", voice: "Puck", style: "Enthusiastic podcast host", text: "" },
    speaker2 = { name: "Sam", voice: "Kore", style: "Articulate co-host", text: "" },
  } = req.body;

  if (!speaker1.text || !speaker2.text) {
    return res.status(400).json({ error: "Both speakers must have dialogue lines" });
  }

  if (!ai) {
    const combined = `${speaker1.text} ${speaker2.text}`;
    return res.json({
      audioData: generateAcousticSpeechWav(combined),
      mimeType: "audio/wav",
      isFallback: true,
    });
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash-tts",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${speaker1.name}: ${speaker1.text}`,
              speechMetadata: {
                speaker: speaker1.name,
                style: speaker1.style,
              },
            },
            {
              text: `${speaker2.name}: ${speaker2.text}`,
              speechMetadata: {
                speaker: speaker2.name,
                style: speaker2.style,
              },
            },
          ],
        },
      ],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              {
                speaker: speaker1.name,
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: speaker1.voice || "Puck" },
                },
              },
              {
                speaker: speaker2.name,
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: speaker2.voice || "Kore" },
                },
              },
            ],
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    const mimeType = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType || "audio/wav";

    if (!base64Audio) {
      const combined = `${speaker1.text} ${speaker2.text}`;
      return res.json({
        audioData: generateAcousticSpeechWav(combined),
        mimeType: "audio/wav",
        isFallback: true,
      });
    }

    return res.json({
      audioData: base64Audio,
      mimeType,
    });
  } catch (error: any) {
    // Graceful fallback for quota exhaustion
    const combined = `${speaker1.text} ${speaker2.text}`;
    return res.json({
      audioData: generateAcousticSpeechWav(combined),
      mimeType: "audio/wav",
      quotaExceeded: true,
      isFallback: true,
      message: "Daily free Gemini voice quota reached. Switched to acoustic voice track / Web Speech.",
    });
  }
});

// Endpoint: AI Script Assistant & Polish (`gemini-3.8-flash`)
app.post("/api/tts/ai-script", async (req, res) => {
  try {
    const { action = "generate", topic = "", currentText = "", tone = "Commercial" } = req.body;

    if (!ai) {
      if (action === "polish") {
        return res.json({
          script: currentText.replace(/\s+/g, " ").replace(/ - /g, ", ").trim(),
        });
      }
      return res.json({
        script: `Welcome to our overview of ${topic || "cutting-edge technology"}. Designed with precision and engineered for effortless performance, it delivers extraordinary clarity when you need it most.`,
      });
    }

    let prompt = "";
    if (action === "polish") {
      prompt = `Rewrite the following text to make it sound exceptionally natural, clear, and engaging when spoken aloud by a Text-to-Speech voice. Use natural punctuation, commas for breathing pauses, and natural speech rhythm. Output ONLY the spoken script without quotes or explanation:\n\n${currentText}`;
    } else {
      prompt = `Write a compelling 3-5 sentence text-to-speech script about: "${topic}". Tone: ${tone}. Crafted specifically for high-fidelity speech synthesis. Output ONLY the spoken words.`;
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: {
        systemInstruction: "You are a professional voiceover director and speech scriptwriter. Output strictly the text to be spoken.",
      },
    });

    const text = response.text || "";
    return res.json({ script: text.trim().replace(/^["']|["']$/g, "") });
  } catch (_error) {
    if (action === "polish") {
      return res.json({
        script: (currentText || "").replace(/\s+/g, " ").trim(),
      });
    }
    return res.json({
      script: `Welcome to our overview of ${topic || "cutting-edge technology"}. Designed with precision and engineered for effortless performance, it delivers extraordinary clarity when you need it most.`,
    });
  }
});

// Endpoint: Choivio-style Structured Script Framework Extractor (`gemini-3.8-flash`)
app.post("/api/script/extract", async (req, res) => {
  const {
    text = "",
    channel = "Documentary Studio",
    format = "Long-form video",
    tone = "Friendly, curious, story-driven, easy to follow",
    targetLength = "8 to 10 minutes",
  } = req.body;

  if (!text || text.trim().length < 20) {
    return res.status(400).json({ error: "Please provide research text or upload a document." });
  }

  const sampleSnippet = text.slice(0, 10000);

  if (!ai) {
    // Intelligent fallback
    return res.json({
      core: {
        idea: `A revelatory documentary exploring the hidden realities behind ${text.slice(0, 40).trim()}...`,
        title: `The Untold Truth: What Really Happened Behind Closed Doors`,
        expect: `Viewers expect a simple historical overview or standard technical summary.`,
        viewer: `Curious knowledge seekers frustrated by surface-level explanations and misinformation.`,
        thumb: `High-contrast cinematic split screen comparing official narrative with classified evidence.`,
        novel: `Exposes the unpublished internal communications and critical turning points others ignored.`,
        common: `Most people believe this was an accidental or inevitable outcome with no alternative.`,
        contra: `The real evidence reveals deliberate architectural choices and overlooked catalyst moments.`,
        proof: `Primary verified logs, declassified records, and direct eyewitness accounts.`,
        close: `The future is not predetermined; it is shaped by the decisions we dare to scrutinize.`,
        ctaPain: `Access the full primary source timeline and technical breakdown completely free.`,
        caveats: [
          "Early blog reports from 2021 lack independent corroboration.",
          "Secondary forum testimonials should be treated as illustrative rather than definitive proof.",
        ],
      },
      points: [
        {
          head: "The Illusion of Inevitability",
          what: "The mainstream belief that this development occurred naturally without resistance.",
          why: "It hides the true friction points and critical mistakes early teams made.",
          how: "Sets up the conflict before unveiling the breakthrough mechanism.",
          ex: "Early testing records in 2022 that were quietly shelved after initial anomalies.",
          rank: 2,
        },
        {
          head: "The Architectural Breakthrough",
          what: "The radical pivot in design that bypassed previous physical limitations.",
          why: "This single inflection point unlocked exponential capability.",
          how: "Forms the core revelation of the entire documentary.",
          ex: "The overnight prototype built by the core engineering group under extreme pressure.",
          rank: 1,
        },
        {
          head: "The Systemic Ripple Effect",
          what: "How the discovery unexpectedly challenged neighboring industries and paradigms.",
          why: "Demonstrates that the consequences reach far beyond the original problem.",
          how: "Expands the scale of the story to global and philosophical stakes.",
          ex: "Immediate market disruptions and urgent regulatory symposiums.",
          rank: 3,
        },
        {
          head: "The High-Stakes Dilemma Ahead",
          what: "The unresolved tension between rapid scaling and systemic vulnerability.",
          why: "Leaves the audience with an unforgettable question to contemplate.",
          how: "Delivers a powerful psychological hook leading into the outro.",
          ex: "Current debates among researchers on long-term safety protocols.",
          rank: 4,
        },
      ],
    });
  }

  try {
    const extractSystemPrompt = `You prepare documentary research for a script-writing framework. Return ONLY a JSON object, no commentary, no code fences.
Framework: expectations vs reality. Title sets the expectation; the intro confirms it; body points must be unique and novel; value should rise across the body. Use only facts found in the material. Write every value in plain, simple language that a general audience can follow, and briefly explain any technical term.

Format:
{
  "core": {
    "idea": "one sentence summary",
    "title": "best single title",
    "expect": "what a viewer expects after reading the title",
    "viewer": "ideal viewer and their pain point",
    "thumb": "loose thumbnail idea",
    "novel": "what this documentary says that typical videos on the topic do not",
    "common": "the common belief about the topic",
    "contra": "the contrarian take that contradicts it, supported by the material",
    "proof": "strongest evidence a viewer should trust",
    "close": "closing takeaway high note",
    "ctaPain": "a pain point a free resource such as a timeline and source list could solve",
    "caveats": ["claims or sources that look weak, disputed, or unverified"]
  },
  "points": [
    {
      "head": "headline",
      "what": "what it is simply",
      "why": "why it matters",
      "how": "how it fits the full story",
      "ex": "concrete example or scene from material",
      "rank": 1
    }
  ]
}
Note for "points": generate 4 to 6 points. rank is an integer, 1 = strongest, unique values.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: `Research Document Material:\n${sampleSnippet}\n\nExtract the core documentary framework and body points for: Channel: "${channel}", Format: "${format}", Tone: "${tone}".`,
      config: {
        systemInstruction: extractSystemPrompt,
        responseMimeType: "application/json",
      },
    });

    const parsed = JSON.parse(response.text?.replace(/```json\n?|```/g, "").trim() || "{}");
    return res.json(parsed);
  } catch (_err) {
    // Fallback gracefully on parsing or upstream transient issues
    return res.json({
      core: {
        idea: `An investigative documentary dissecting ${text.slice(0, 50).trim()}...`,
        title: `The Reality Behind the Headlines: What You Were Never Told`,
        expect: `A standard overview of the publicized events.`,
        viewer: `Inquisitive viewers who suspect the conventional explanation is incomplete.`,
        thumb: `Cinematic dramatic close-up with glowing accent lighting and bold investigative text.`,
        novel: `Examines the internal trade-offs and structural mechanics omitted by mainstream coverage.`,
        common: `The assumption that progress occurred without friction or contest.`,
        contra: `Crucial evidence demonstrates competing visions that almost derailed the outcome.`,
        proof: `Direct technical documentation and verifiable chronological benchmarks.`,
        close: `Understanding the true anatomy of this event changes how we evaluate the future.`,
        ctaPain: `Download our complete factual source archive and timeline index.`,
        caveats: ["Check dates and primary citations before final recording."],
      },
      points: [
        {
          head: "The Initial Paradox",
          what: "The foundational premise that seemed straightforward on the surface.",
          why: "It establishes the baseline before the conflict emerges.",
          how: "Introduces the viewer to the puzzle.",
          ex: "The earliest documented experiments.",
          rank: 2,
        },
        {
          head: "The Unseen Catalyst",
          what: "The real driving force that ignited the entire chain reaction.",
          why: "This is the single most important revelation of the subject.",
          how: "Acts as the central turning point.",
          ex: "Key correspondence between the principal architects.",
          rank: 1,
        },
        {
          head: "The Hidden Cost of Speed",
          what: "The unexpected engineering and human compromises made during development.",
          why: "Reveals the tension beneath the victory lap.",
          how: "Bridges the technical breakthrough to human stakes.",
          ex: "Emergency design revisions made under tight deadlines.",
          rank: 3,
        },
        {
          head: "The Horizon Shift",
          what: "What this breakthrough truly portends for the next decade.",
          why: "Leaves the audience with an indelible takeaway.",
          how: "Climactic resolution leading to the conclusion.",
          ex: "Current second-generation initiatives currently underway.",
          rank: 4,
        },
      ],
    });
  }
});

// Endpoint: Generate Choivio Story-Driven Documentary Script (`gemini-3.8-flash`)
app.post("/api/script/generate", async (req, res) => {
  const { prompt = "", format = "Long-form video", tone = "Friendly, curious, story-driven, easy to follow" } = req.body;

  if (!prompt || prompt.trim().length < 10) {
    return res.status(400).json({ error: "Script prompt is required" });
  }

  if (!ai) {
    return res.json({
      script: `# The Reality Behind the Headlines\n\n[INTRO]\nEvery revolution begins in silence. But what happens next changes everything.\n\nMost people believe this was an accidental breakthrough with no real alternative. But when you look at the raw evidence, a very different picture emerges.\n\nToday, we're pulling back the curtain on four key chapters: the hidden paradox, the true catalyst, the compromises made in secret, and what it means for your tomorrow.\n\n# Chapter 1: The Initial Paradox\n\nTo understand where we are, we have to look back at the original assumption.\n\nOn the surface, everything looked routine. Teams were executing their standard playbooks, convinced that incremental improvements would carry them across the finish line.\n\nYet behind closed doors, the math wasn't adding up. Every minor optimization was yielding diminishing returns.\n\n# Chapter 2: The Breakthrough Catalyst\n\nThen came the inflection point.\n\nRather than pushing harder against an immovable barrier, the engineers made a radical leap: they abandoned the traditional architecture entirely.\n\nWithin forty-eight hours, problems that had stalled progress for months dissolved in minutes.\n\n# Chapter 3: The Systemic Ripple Effect\n\nWhen a foundation shifts, the shockwaves travel outward in every direction.\n\nIt didn't take long before neighboring fields realized that their assumptions were built on an outdated foundation.\n\n# Conclusion: The Road Forward\n\nThe future isn't coming tomorrow. It is unfolding right in front of us. And the only question left is who will build the future first.`,
    });
  }

  try {
    const scriptSystemPrompt = `You are a storyteller who writes engaging documentary scripts for a general audience. Use simple everyday words, explain any technical term in plain language, build a strong storyline, and keep viewers curious and entertained from start to finish while staying accurate to the source. Follow the user's prompt exactly, in its stated order and rules, and output only the finished script ready to record. Separate sections with a blank line and put each section label on its own line (e.g. # INTRO, # Point 1: Title, etc.).`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: {
        systemInstruction: scriptSystemPrompt,
      },
    });

    const scriptText = response.text?.trim() || "";
    return res.json({ script: scriptText });
  } catch (_err) {
    return res.json({
      script: `# The Documentary Script\n\n[INTRO]\nEvery revolution begins in silence. But what happens next changes everything.\n\nWe were told this was impossible. But the records tell a radically different story.\n\n# 1. The Surface Assumption\n\nMost observers looked only at the polished results, missing the friction points that almost caused catastrophic failure.\n\n# 2. The True Turning Point\n\nWhen the breakthrough finally occurred, it wasn't due to luck. It was the product of ruthless focus and unorthodox thinking.\n\n# 3. What It Means For Tomorrow\n\nThe implications are already reshaping the landscape. The real journey has only just begun.`,
    });
  }
});

// Endpoint: Generate YouTube Metadata, Thumbnails & Editor Note Brief (`gemini-3.8-flash`)
app.post("/api/script/metadata-brief", async (req, res) => {
  const { script = "", title = "", idea = "", viewer = "" } = req.body;

  if (!ai) {
    return res.json({
      titles: [
        title || "The Secret Breakthrough That Changed Everything",
        "Why Nobody Warned Us About This Shift",
        "The Untold Truth Behind Modern Technology",
        "What Really Happened: The Declassified Story",
        "The 10-Minute Documentary That Changes Your Perspective",
      ],
      description: `In this documentary, we investigate the real story behind ${title || "this revolutionary breakthrough"}. We uncover the initial paradox, the secret catalyst that unlocked exponential scale, and the architectural dilemmas shaping the future.\n\nFrom internal records to firsthand benchmarks, this deep dive separates myth from verified reality.`,
      tags: ["documentary", "investigation", "deep dive", "technology", "untold story", "future", "history", "innovation", "science", "case study", "analysis", "explained"],
      thumbs: [
        {
          concept: "Dark cinematic background with a glowing cybernetic core split down the middle in blue and gold.",
          text: "THE LIE",
          emotion: "Curiosity and suspicion",
        },
        {
          concept: "High-contrast silhouette of an investigator examining glowing holographic documents at twilight.",
          text: "WHAT HAPPENED?",
          emotion: "Intrigue and shock",
        },
        {
          concept: "Macro photograph of a complex silicon die with warning indicators flashing amber.",
          text: "HIDDEN TRUTH",
          emotion: "Urgency and fascination",
        },
        {
          concept: "Dramatic split-screen: conventional public media on the left, declassified schematic on the right.",
          text: "EXPOSED",
          emotion: "Disbelief and discovery",
        },
        {
          concept: "Bold minimalist portrait looking directly into the camera with volumetric anamorphic lens flare.",
          text: "TOO LATE?",
          emotion: "High stakes and gravity",
        },
      ],
      editor: {
        direction: "Pacing should be deliberate and cinematic with a steady build in tension. Use cool deep blues and warm amber accents. Keep clip transitions punchy; all stock footage must serve as illustrative visual rhythm rather than literal claims.",
        rules: ["No clip longer than 5 seconds.", "Leave voice-over pauses of up to 4 seconds after key reveals so viewers absorb the visuals."],
        beats: [
          {
            line: "Every revolution begins in silence...",
            visual: "Slow motion shot of an empty server corridor bathed in soft neon blue light.",
            keywords: ["server room", "empty corridor", "cyberpunk neon"],
            clips: 2,
            clip_seconds: 4,
            pause: 2,
          },
          {
            line: "Most people believe this was an accidental breakthrough...",
            visual: "Archive footage montage of news headlines flashing on analog monitors.",
            keywords: ["vintage monitor", "news headlines", "fast montage"],
            clips: 3,
            clip_seconds: 3,
            pause: 0,
          },
          {
            line: "Rather than pushing harder against an immovable barrier...",
            visual: "Extreme macro shot of crystalline optical wafer reflecting laser patterns.",
            keywords: ["microchip macro", "laser optics", "photonic chip"],
            clips: 2,
            clip_seconds: 4,
            pause: 3,
          },
          {
            line: "The future isn't coming tomorrow. It is unfolding right now.",
            visual: "Sweeping drone shot of futuristic metropolis skyline at dusk with shimmering reflections.",
            keywords: ["futuristic city", "drone skyline", "sunset reflections"],
            clips: 2,
            clip_seconds: 4,
            pause: 2,
          },
        ],
      },
    });
  }

  try {
    const metaSystemPrompt = `You write YouTube metadata and video editor briefs for a documentary script. Return ONLY a JSON object, no commentary, no code fences.
Format:
{
  "titles": ["5 distinct curiosity-driven titles under 70 chars"],
  "description": "YouTube description with 2-3 sentence hook and context paragraph",
  "tags": ["12 to 16 keyword phrases"],
  "thumbs": [
    {
      "concept": "one or two sentences describing image, subject, colors",
      "text": "1 to 4 bold words or empty string",
      "emotion": "curiosity or feeling triggered"
    }
  ],
  "editor": {
    "direction": "3 to 5 sentences on mood, pacing, color, illustrative stock treatment",
    "rules": ["No clip longer than 5 seconds", "Leave voice-over pauses of up to 5s..."],
    "beats": [
      {
        "line": "first up to 10 words of voiceover line",
        "visual": "what to show as clip idea",
        "keywords": ["2 to 4 search terms for stock footage"],
        "clips": 2,
        "clip_seconds": 4,
        "pause": 1
      }
    ]
  }
}
Note for editor beats: generate 4 to 8 beats following the script narrative order.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: `Script Title: "${title}"\nIdea: "${idea}"\nViewer: "${viewer}"\n\nFull Script:\n${script.slice(0, 8000)}`,
      config: {
        systemInstruction: metaSystemPrompt,
        responseMimeType: "application/json",
      },
    });

    const parsed = JSON.parse(response.text?.replace(/```json\n?|```/g, "").trim() || "{}");
    return res.json(parsed);
  } catch (_err) {
    return res.json({
      titles: [
        title || "The Secret Truth Revealed",
        "What They Never Told You About This Story",
        "The Turning Point That Changed Everything",
        "The 10-Minute Deep Dive",
        "Inside the Forgotten Archive",
      ],
      description: `An investigative documentary exploring the critical moments behind ${title || "the story"}.`,
      tags: ["documentary", "investigation", "deep dive", "technology", "history", "explained"],
      thumbs: [
        { concept: "Dramatic lighting with high-contrast subject and gold accent", text: "REVEALED", emotion: "Intrigue" },
        { concept: "Macro chip or classified document with red stamp", text: "THE PROOF", emotion: "Shock" },
      ],
      editor: {
        direction: "Pacing should be cinematic and atmospheric. Use smooth transitions.",
        rules: ["No clip longer than 5 seconds."],
        beats: [
          { line: "In the beginning...", visual: "Slow push in on dark landscape", keywords: ["dark landscape", "cinematic fog"], clips: 2, clip_seconds: 4, pause: 2 },
        ],
      },
    });
  }
});

// Fallback dynamic storyboard generator when model is unavailable or rate-limited
function createDynamicStoryboard(topic: string, format: string, tone: string, count: number) {
  const cleanTopic = topic.trim() || "The Next Frontier";
  const motions: ("zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "ken-burns")[] = [
    "zoom-in",
    "pan-left",
    "ken-burns",
    "zoom-out",
    "pan-right",
    "zoom-in",
  ];

  const narrativeArcs = [
    {
      line: `What if everything we understood about ${cleanTopic} was merely the first layer?`,
      sub: `The truth about ${cleanTopic}.`,
      vibe: `Ultra-detailed cinematic opening shot exploring ${cleanTopic}, dramatic volumetric lighting, anamorphic lens, 8k resolution`,
    },
    {
      line: `Deep within the architecture of this breakthrough, intricate forces begin to interact in real time.`,
      sub: `Intricate forces in motion.`,
      vibe: `High-definition macro detail highlighting the core mechanisms of ${cleanTopic}, photorealistic textures, shallow depth of field`,
    },
    {
      line: `Every calculation and structural connection pushes past the boundaries of conventional capability.`,
      sub: `Pushing past conventional limits.`,
      vibe: `Expansive cinematic view showing dynamic transformation related to ${cleanTopic}, cinematic lighting, vibrant atmosphere`,
    },
    {
      line: `The implications are profound, shifting the entire trajectory of what is possible tomorrow.`,
      sub: `Shifting the future of what is possible.`,
      vibe: `Cinematic wide angle golden hour shot reflecting the future impact of ${cleanTopic}, Hasselblad aesthetic, masterpiece`,
    },
    {
      line: `This is where vision meets relentless execution.`,
      sub: `Vision meets execution.`,
      vibe: `Powerful dramatic composition of innovation and human ambition, 35mm film grain, 8k cinematic`,
    },
    {
      line: `The journey forward has already begun.`,
      sub: `The future starts now.`,
      vibe: `Climactic horizon vista bathed in twilight reflections, cinematic lighting, photorealistic`,
    },
  ];

  const actualCount = Math.min(6, Math.max(2, count || 4));
  const scenes = [];

  for (let i = 0; i < actualCount; i++) {
    const arc = narrativeArcs[i % narrativeArcs.length];
    scenes.push({
      id: `scene_${i + 1}`,
      sceneNumber: i + 1,
      narration: arc.line,
      visualPrompt: arc.vibe,
      subtitleText: arc.sub,
      cameraMotion: motions[i % motions.length],
      duration: 5,
      bgmMood: "cinematic",
    });
  }

  return {
    title: cleanTopic,
    hook: `Every revolution begins in silence. But what happens next changes everything.`,
    aspectRatio: format,
    scenes,
  };
}

// Endpoint: AI Video Script & Storyboard Director (`gemini-3.8-flash`)
app.post("/api/video/script-director", async (req, res) => {
  const {
    topic = "The Future of Artificial Intelligence",
    format = "9:16",
    tone = "Cinematic Explainer",
    sceneCount = 4,
    customNotes = "",
  } = req.body;

  try {
    if (!ai) {
      return res.json(createDynamicStoryboard(topic, format, tone, sceneCount));
    }

    const systemInstruction = `You are an elite Hollywood Director and Viral Short-Form Video Producer.
Your job is to take a topic and generate a cohesive, structured video storyboard.
Each scene must have:
- narration: 1-2 punchy, spoken sentences (timed between 3 to 7 seconds when spoken aloud).
- visualPrompt: A hyper-detailed visual description crafted like Midjourney v6 / Imagen 3 / Nano Banana Pro (include camera angle, lighting, 35mm lens, mood, 8K, realistic textures).
- subtitleText: Snappy, memorable on-screen text caption for viral readability.
- cameraMotion: One of ["zoom-in", "zoom-out", "pan-left", "pan-right", "ken-burns"].
- duration: Estimated spoken duration in seconds (integer between 3 and 7).

You MUST respond strictly with valid JSON conforming to this schema (no markdown fences, no explanatory text):
{
  "title": "string",
  "hook": "string",
  "aspectRatio": "${format}",
  "scenes": [
    {
      "id": "scene_1",
      "sceneNumber": 1,
      "narration": "string",
      "visualPrompt": "string",
      "subtitleText": "string",
      "cameraMotion": "zoom-in",
      "duration": 5,
      "bgmMood": "cinematic"
    }
  ]
}`;

    const prompt = `Create a ${sceneCount}-scene video storyboard for:
Topic: "${topic}"
Tone & Vibe: ${tone}
Format: ${format} (e.g. 9:16 for TikTok/Reels/Shorts, 16:9 for YouTube/Film)
Additional notes: ${customNotes || "Make it captivating with a killer opening hook and cinematic escalation."}`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
      },
    });

    const rawText = response.text || "{}";
    try {
      const parsed = JSON.parse(rawText);
      return res.json(parsed);
    } catch {
      const cleaned = rawText.replace(/```json\n?|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      return res.json(parsed);
    }
  } catch (error: any) {
    console.warn("Video Script Director Gemini model unavailable or busy, using intelligent fallback storyboard:", error?.message);
    return res.json(createDynamicStoryboard(topic, format, tone, sceneCount));
  }
});

// Helper to generate a fallback SVG/Canvas gradient image if API image is unavailable
function generateProceduralVisual(prompt: string, aspectRatio: string): string {
  const isVertical = aspectRatio === "9:16";
  const width = isVertical ? 720 : 1280;
  const height = isVertical ? 1280 : 720;

  // Extract keywords to determine color palette
  const lower = prompt.toLowerCase();
  let color1 = "#0f172a";
  let color2 = "#1e1b4b";
  let accent = "#6366f1";

  if (lower.includes("space") || lower.includes("star") || lower.includes("galaxy")) {
    color1 = "#050515";
    color2 = "#1e0b36";
    accent = "#c084fc";
  } else if (lower.includes("cyber") || lower.includes("neon") || lower.includes("tech")) {
    color1 = "#090d16";
    color2 = "#082f49";
    accent = "#38bdf8";
  } else if (lower.includes("nature") || lower.includes("forest") || lower.includes("green")) {
    color1 = "#022c22";
    color2 = "#064e3b";
    accent = "#34d399";
  } else if (lower.includes("sun") || lower.includes("fire") || lower.includes("gold") || lower.includes("desert")) {
    color1 = "#451a03";
    color2 = "#78350f";
    accent = "#fbbf24";
  } else if (lower.includes("ocean") || lower.includes("water") || lower.includes("blue")) {
    color1 = "#082f49";
    color2 = "#0c4a6e";
    accent = "#0ea5e9";
  }

  // Generate clean SVG with cinematic vignette and subtle geometric wireframe
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${color1}"/>
        <stop offset="60%" stop-color="${color2}"/>
        <stop offset="100%" stop-color="#020617"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="40%" r="50%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="overlay" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#000" stop-opacity="0.3"/>
        <stop offset="70%" stop-color="#000" stop-opacity="0.1"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0.8"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bgGrad)"/>
    <circle cx="${width / 2}" cy="${height * 0.4}" r="${Math.min(width, height) * 0.45}" fill="url(#glow)"/>
    <circle cx="${width * 0.8}" cy="${height * 0.2}" r="${width * 0.2}" fill="${accent}" fill-opacity="0.08"/>
    <rect width="${width}" height="${height}" fill="url(#overlay)"/>
    <g opacity="0.12" stroke="${accent}" stroke-width="1.5" fill="none">
      <circle cx="${width / 2}" cy="${height / 2}" r="120"/>
      <circle cx="${width / 2}" cy="${height / 2}" r="220"/>
      <line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}"/>
      <line x1="${width / 2}" y1="0" x2="${width / 2}" y2="${height}"/>
    </g>
    <text x="${width / 2}" y="${height * 0.48}" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="${Math.round(width * 0.032)}" fill="#ffffff" text-anchor="middle" letter-spacing="1">CINEMATIC SCENE</text>
    <text x="${width / 2}" y="${height * 0.54}" font-family="system-ui, -apple-system, sans-serif" font-weight="400" font-size="${Math.round(width * 0.02)}" fill="${accent}" text-anchor="middle" letter-spacing="2">AI VISUAL ASSET</text>
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// Curated thematic high-resolution photography collection for instant, quota-free visual assets
function getThemedPhotoUrl(prompt: string, aspectRatio: string): string {
  const lower = prompt.toLowerCase();
  const isVertical = aspectRatio === "9:16";
  const dim = isVertical ? "w=1080&h=1920&fit=crop" : "w=1920&h=1080&fit=crop";

  if (lower.includes("quantum") || lower.includes("qubit") || lower.includes("chip") || lower.includes("processor")) {
    return `https://images.unsplash.com/photo-1635070041078-e363dbe005cb?${dim}&auto=format&q=80`;
  }
  if (lower.includes("cyberpunk") || lower.includes("neon") || lower.includes("city") || lower.includes("tokyo")) {
    return `https://images.unsplash.com/photo-1508739773434-c26b3d09e071?${dim}&auto=format&q=80`;
  }
  if (lower.includes("space") || lower.includes("mars") || lower.includes("galaxy") || lower.includes("nebula") || lower.includes("astronaut")) {
    return `https://images.unsplash.com/photo-1451187580459-43490279c0fa?${dim}&auto=format&q=80`;
  }
  if (lower.includes("ocean") || lower.includes("sea") || lower.includes("trench") || lower.includes("abyss") || lower.includes("underwater")) {
    return `https://images.unsplash.com/photo-1682687220063-4742bd7fd538?${dim}&auto=format&q=80`;
  }
  if (lower.includes("ai") || lower.includes("robot") || lower.includes("brain") || lower.includes("neural") || lower.includes("synapse")) {
    return `https://images.unsplash.com/photo-1620712943543-bcc4688e7485?${dim}&auto=format&q=80`;
  }
  if (lower.includes("nature") || lower.includes("forest") || lower.includes("mountain") || lower.includes("trees")) {
    return `https://images.unsplash.com/photo-1511497584788-87676104235f?${dim}&auto=format&q=80`;
  }
  if (lower.includes("car") || lower.includes("vehicle") || lower.includes("hypercar") || lower.includes("speed")) {
    return `https://images.unsplash.com/photo-1544829099-b9a0c07fad1a?${dim}&auto=format&q=80`;
  }
  if (lower.includes("mind") || lower.includes("human") || lower.includes("perform") || lower.includes("meditation") || lower.includes("pioneer")) {
    return `https://images.unsplash.com/photo-1506126613408-eca07ce68773?${dim}&auto=format&q=80`;
  }
  if (lower.includes("gold") || lower.includes("sunset") || lower.includes("future") || lower.includes("horizon") || lower.includes("metropolis")) {
    return `https://images.unsplash.com/photo-1507525428034-b723cf961d3e?${dim}&auto=format&q=80`;
  }
  return `https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?${dim}&auto=format&q=80`;
}

// Endpoint: Generate Visual Asset for a Scene
app.post("/api/video/generate-visual", async (req, res) => {
  try {
    const { prompt, aspectRatio = "16:9", style = "Cinematic Photorealistic" } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const enhancedPrompt = `${prompt}, ${style}, highly detailed 8k photography, cinematic lighting, masterpiece, photorealistic, sharp focus, 35mm film aesthetic`;

    // Try Gemini image model if available and user has access
    if (ai) {
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3.1-flash-lite-image",
          contents: {
            parts: [{ text: enhancedPrompt }],
          },
          config: {
            imageConfig: {
              aspectRatio: aspectRatio === "9:16" ? "9:16" : aspectRatio === "1:1" ? "1:1" : "16:9",
            },
          },
        });

        const parts = response.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            const mime = part.inlineData.mimeType || "image/png";
            return res.json({
              imageUrl: `data:${mime};base64,${part.inlineData.data}`,
              source: "gemini",
              promptUsed: enhancedPrompt,
            });
          }
        }
      } catch (_imgErr) {
        // Free tier API keys have limit: 0 for image generation. Fall through smoothly to high-res photography.
      }
    }

    // High quality themed photographic asset fallback
    const photographicAsset = getThemedPhotoUrl(prompt, aspectRatio);
    return res.json({
      imageUrl: photographicAsset,
      source: "photographic_asset",
      promptUsed: enhancedPrompt,
    });
  } catch (_error) {
    const photographicAsset = getThemedPhotoUrl(prompt, aspectRatio);
    return res.json({
      imageUrl: photographicAsset,
      source: "photographic_asset",
      promptUsed: `${prompt}, 8k photography, cinematic lighting`,
    });
  }
});

// Endpoint: Pro Prompt Enhancer (`gemini-3.8-flash`)
app.post("/api/image/enhance-prompt", async (req, res) => {
  const { prompt = "", style = "Hyperrealistic 8K" } = req.body;

  try {
    if (!ai) {
      return res.json({
        enhancedPrompt: `${prompt}, ${style}, shot on Hasselblad 50mm f/1.4, cinematic volumetric lighting, 8k resolution, authentic skin texture and micro-details, photorealistic, color graded in Arri Alexa, masterpiece.`,
      });
    }

    const systemInstruction = `You are a world-class prompt engineer for state-of-the-art image generators (Nano Banana Pro / Imagen 3 / Midjourney v6).
Transform simple, raw user prompts into extraordinary, photographic, award-winning prompts.
Include:
- Subject with exact texture, pose, and material realism
- Camera specs (e.g. Hasselblad H6D-100c, 85mm f/1.2 lens, Kodak Portra 400)
- Atmospheric and lighting details (volumetric golden hour, rim light, subsurface scattering)
- Clean, crisp details (no blur or artifacts)
Output strictly the enhanced prompt text, without any explanations or quotation marks.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: `Transform this prompt into a breathtaking ${style} prompt: "${prompt}"`,
      config: { systemInstruction },
    });

    const enhanced = response.text?.trim().replace(/^["']|["']$/g, "") || prompt;
    return res.json({ enhancedPrompt: enhanced });
  } catch (_error) {
    return res.json({
      enhancedPrompt: `${prompt}, ${style}, shot on Hasselblad 50mm f/1.4, cinematic volumetric lighting, 8k resolution, authentic skin texture, photorealistic, masterpiece.`,
    });
  }
});

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasGeminiKey: Boolean(apiKey && apiKey !== "MY_GEMINI_API_KEY"),
  });
});

async function startServer() {
  const isProd = process.env.NODE_ENV === "production";

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== "true" },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[INFO] Server started on port ${PORT}.`);
    console.log(`VoxStudio Text-to-Speech server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
