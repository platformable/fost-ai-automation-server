const express = require("express")
const multer = require("multer")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { execFile } = require("child_process")
const { promisify } = require("util")

require("dotenv").config()

const { Agent, setGlobalDispatcher } = require("undici")

const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai")

const { GoogleAIFileManager } = require("@google/generative-ai/server")

// --------------------------------------------------
// CONFIG
// --------------------------------------------------

setGlobalDispatcher(
  new Agent({
    headersTimeout: 1200000,
    bodyTimeout: 1200000,
  }),
)

const app = express()

app.use(
  express.json({
    limit: "150mb",
  }),
)

app.use(
  express.urlencoded({
    extended: true,
    limit: "150mb",
  }),
)

const PORT = process.env.PORT || 5000

const upload = multer({
  dest: "uploads/",
})

const execFileAsync = promisify(execFile)

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY)

// --------------------------------------------------
// TRANSCRIPTION CONFIG
// --------------------------------------------------

// Duración aproximada de cada chunk.
// 9 horas ≈ 36 chunks.
const CHUNK_DURATION = 15 * 60

// Número de chunks procesados simultáneamente.
const MAX_CONCURRENCY = 3

// Intentos normales.
const MAX_RETRIES = 3

// --------------------------------------------------
// SILENCE CONFIG
// --------------------------------------------------

// Silencios de esta duración o mayores serán
// eliminados/reducidos durante el preprocesamiento.
//
// 2.5 segundos permite conservar pausas naturales
// mientras elimina silencios largos.
const SILENCE_DURATION = 2.5

// Nivel de silencio.
// -35dB funciona razonablemente bien para conferencias.
// Si el audio tiene mucho ruido de fondo podemos
// bajarlo a -30dB.
const SILENCE_THRESHOLD = "-35dB"

// --------------------------------------------------
// UTILS
// --------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, {
    recursive: true,
  })
}

function removeDirectory(directory) {
  if (fs.existsSync(directory)) {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
    })
  }
}

// --------------------------------------------------
// DETECT / REMOVE LONG SILENCES
// --------------------------------------------------

async function cleanAudio(inputPath, outputPath) {
  console.log("")
  console.log("Limpiando silencios largos con FFmpeg...")

  const silenceFilter =
    "silenceremove=start_periods=1:start_duration=0.3:start_threshold=-35dB:stop_periods=-1:stop_duration=2.5:stop_threshold=-35dB:stop_silence=0.4"

  console.log("FFmpeg filter:")
  console.log(silenceFilter)

  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",

    "-i",
    inputPath,

    "-ac",
    "1",

    "-ar",
    "16000",

    "-af",
    silenceFilter,

    "-c:a",
    "libmp3lame",

    "-b:a",
    "64k",

    "-y",

    outputPath,
  ])

  console.log("Audio limpio generado:", outputPath)

  return outputPath
}
// --------------------------------------------------
// SPLIT AUDIO
// --------------------------------------------------

async function splitAudio(inputPath, outputDirectory) {
  ensureDirectory(outputDirectory)

  console.log("")
  console.log("Dividiendo audio limpio con FFmpeg...")

  const cleanedAudioPath = path.join(outputDirectory, "audio_cleaned.mp3")

  // ------------------------------------------
  // 1. REMOVE LONG SILENCES
  // ------------------------------------------

  await cleanAudio(inputPath, cleanedAudioPath)

  // ------------------------------------------
  // 2. SPLIT INTO CHUNKS
  // ------------------------------------------

  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",

    "-i",
    cleanedAudioPath,

    "-f",
    "segment",

    "-segment_time",
    String(CHUNK_DURATION),

    "-segment_start_number",
    "0",

    "-c",
    "copy",

    path.join(outputDirectory, "chunk_%03d.mp3"),
  ])

  const chunks = fs
    .readdirSync(outputDirectory)
    .filter((file) => file.startsWith("chunk_") && file.endsWith(".mp3"))
    .sort()
    .map((file) => path.join(outputDirectory, file))

  console.log("")
  console.log(`Audio dividido en ${chunks.length} chunks.`)

  console.log(`Duración aproximada por chunk: ${CHUNK_DURATION / 60} minutos.`)

  return chunks
}

// --------------------------------------------------
// UPLOAD TO GEMINI
// --------------------------------------------------

async function uploadToGemini(filePath, chunkNumber) {
  console.log(`[Chunk ${chunkNumber}] Subiendo a Gemini...`)

  const response = await fileManager.uploadFile(filePath, {
    mimeType: "audio/mpeg",

    displayName: `conference_chunk_${chunkNumber}.mp3`,
  })

  let fileState = response.file

  while (fileState.state === "PROCESSING") {
    console.log(`[Chunk ${chunkNumber}] Gemini procesando archivo...`)

    await sleep(5000)

    fileState = await fileManager.getFile(response.file.name)
  }

  if (fileState.state === "FAILED") {
    throw new Error(`Gemini no pudo procesar el chunk ${chunkNumber}`)
  }

  return fileState
}

// --------------------------------------------------
// REPETITION DETECTION
// --------------------------------------------------

function detectSuspiciousRepetition(text) {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!normalized) {
    return false
  }

  const words = normalized.split(" ").filter(Boolean)

  // Textos pequeños no deberían
  // considerarse sospechosos.
  if (words.length < 40) {
    return false
  }

  // ------------------------------------------
  // 1. PALABRA DOMINANTE
  // ------------------------------------------

  const counts = {}

  for (const word of words) {
    counts[word] = (counts[word] || 0) + 1
  }

  const maxCount = Math.max(...Object.values(counts))

  const dominantRatio = maxCount / words.length

  if (dominantRatio > 0.3) {
    return true
  }

  // ------------------------------------------
  // 2. FRASES REPETIDAS
  // ------------------------------------------

  const phrases = {}

  for (let i = 0; i < words.length - 3; i++) {
    const phrase = words.slice(i, i + 4).join(" ")

    phrases[phrase] = (phrases[phrase] || 0) + 1
  }

  const maxPhraseCount = Math.max(...Object.values(phrases))

  if (maxPhraseCount >= 8) {
    return true
  }

  return false
}

// --------------------------------------------------
// TRANSCRIBE ONE CHUNK
// --------------------------------------------------

async function transcribeChunk(filePath, chunkNumber) {
  let lastError

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log("")
      console.log(`[Chunk ${chunkNumber}] Transcribiendo...`)

      console.log(`[Chunk ${chunkNumber}] Intento ${attempt}/${MAX_RETRIES}`)

      const file = await uploadToGemini(filePath, chunkNumber)

      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
      })

      // ------------------------------------------
      // PROMPT
      // ------------------------------------------

      const prompt = `
You are a professional conference transcription system.

You are processing ONE SEGMENT of a longer conference recording.

Your ONLY task is to transcribe actual human speech contained in this audio.

CRITICAL ANTI-HALLUCINATION RULES:

- Only transcribe speech that is actually audible.
- If there is silence, output nothing.
- If there is background noise, do not turn it into words.
- If there is microphone noise, do not turn it into words.
- If speech is genuinely unintelligible, do not invent words.
- NEVER repeat a word, phrase or sentence simply because the audio contains silence or noise.
- NEVER generate text to fill empty parts of the audio.
- NEVER loop or repeat the same sentence.
- NEVER summarize.
- NEVER describe what is happening in the audio.
- NEVER add commentary.

TRANSCRIPTION RULES:

- Preserve chronological order.
- Transcribe all meaningful human speech.
- Preserve technical terminology.
- Preserve names, numbers, statistics and product names.
- Remove obvious verbal fillers such as "um", "uh", "you know", etc. when they do not add meaning.
- Remove obvious stuttering when the intended phrase is clear.
- Do not remove meaningful words.
- Do not invent missing words.
- Do not reconstruct sentences that cannot be understood.
- Do not repeat content.
- Return ONLY the transcription.
- Return plain text.

IMPORTANT:

This audio segment may contain long periods of silence.

If you encounter silence or non-speech audio:
DO NOT WRITE ANYTHING FOR THAT PART.

If the entire segment contains no understandable speech,
return an empty response.

Do not assume this is the beginning or end of the conference.
`

      const result = await model.generateContent({
        contents: [
          {
            role: "user",

            parts: [
              {
                fileData: {
                  mimeType: file.mimeType,

                  fileUri: file.uri,
                },
              },

              {
                text: prompt,
              },
            ],
          },
        ],

        generationConfig: {
          temperature: 0,
        },
      })

      const transcription = result.response.text().trim()

      // ------------------------------------------
      // EMPTY TRANSCRIPTION
      // ------------------------------------------

      if (!transcription) {
        console.log(`[Chunk ${chunkNumber}] Sin habla detectable.`)

        return {
          chunk: chunkNumber,
          transcription: "",
        }
      }

      // ------------------------------------------
      // CHECK REPETITION
      // ------------------------------------------

      const suspicious = detectSuspiciousRepetition(transcription)

      if (suspicious) {
        console.warn("")
        console.warn(
          `⚠️ [Chunk ${chunkNumber}] Posible repetición/alucinación detectada.`,
        )

        console.warn(`Longitud: ${transcription.length} caracteres`)

        // No aceptamos el resultado.
        throw new Error(
          "Gemini produjo una transcripción sospechosamente repetitiva.",
        )
      }

      console.log(`[Chunk ${chunkNumber}] Transcripción completada.`)

      console.log(`[Chunk ${chunkNumber}] Caracteres: ${transcription.length}`)

      return {
        chunk: chunkNumber,
        transcription,
      }
    } catch (error) {
      lastError = error

      console.error("")
      console.error(`[Chunk ${chunkNumber}] Error.`)

      console.error(`Intento ${attempt}/${MAX_RETRIES}`)

      console.error(error.message)

      if (attempt < MAX_RETRIES) {
        const waitTime = 5000 * attempt

        console.log(
          `[Chunk ${chunkNumber}] Reintentando en ${
            waitTime / 1000
          } segundos...`,
        )

        await sleep(waitTime)
      }
    }
  }

  throw lastError
}

// --------------------------------------------------
// PROCESS CHUNKS
// --------------------------------------------------

async function processChunks(chunks) {
  const results = new Array(chunks.length)

  let currentIndex = 0

  async function worker(workerId) {
    while (true) {
      const index = currentIndex++

      if (index >= chunks.length) {
        return
      }

      console.log("")
      console.log(`[Worker ${workerId}] Procesando chunk ${index}`)

      results[index] = await transcribeChunk(chunks[index], index)
    }
  }

  const workers = Array.from(
    {
      length: Math.min(MAX_CONCURRENCY, chunks.length),
    },
    (_, index) => worker(index + 1),
  )

  await Promise.all(workers)

  return results
}

// --------------------------------------------------
// MERGE TRANSCRIPTIONS
// --------------------------------------------------

function mergeTranscriptions(results) {
  return results
    .sort((a, b) => a.chunk - b.chunk)
    .map((result) => result.transcription)
    .filter(Boolean)
    .join("\n\n")
}

// --------------------------------------------------
// TRANSCRIBE ENDPOINT
// --------------------------------------------------

app.post("/transcribe", upload.any(), async (req, res) => {
  const jobId = crypto.randomUUID()

  let localFilePath
  let processingDirectory

  try {
    // ------------------------------------------
    // VALIDATE FILE
    // ------------------------------------------

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: "No se recibió ningún archivo de audio.",
      })
    }

    const uploadedFile = req.files[0]

    localFilePath = uploadedFile.path

    processingDirectory = path.join("processing", jobId)

    ensureDirectory(processingDirectory)

    console.log("")
    console.log("========================================")
    console.log("NUEVA TRANSCRIPCIÓN")
    console.log("========================================")
    console.log(`Job: ${jobId}`)
    console.log(`Archivo: ${uploadedFile.originalname}`)
    console.log(`MIME: ${uploadedFile.mimetype}`)
    console.log("========================================")
    console.log("")

    // ------------------------------------------
    // 1. CLEAN + SPLIT AUDIO
    // ------------------------------------------

    const chunks = await splitAudio(localFilePath, processingDirectory)

    // ------------------------------------------
    // 2. TRANSCRIBE CHUNKS
    // ------------------------------------------

    const results = await processChunks(chunks)

    // ------------------------------------------
    // 3. MERGE
    // ------------------------------------------

    const transcription = mergeTranscriptions(results)

    // ------------------------------------------
    // 4. SAVE TXT
    // ------------------------------------------

    const outputFile = path.join(
      processingDirectory,
      `transcripcion_${jobId}.txt`,
    )

    fs.writeFileSync(outputFile, transcription, "utf8")

    console.log("")
    console.log("========================================")
    console.log("TRANSCRIPCIÓN COMPLETADA")
    console.log("========================================")
    console.log(`Chunks: ${chunks.length}`)
    console.log(`Caracteres: ${transcription.length}`)
    console.log(`Archivo: ${outputFile}`)
    console.log("========================================")
    console.log("")

    // ------------------------------------------
    // 5. DELETE ORIGINAL UPLOAD
    // ------------------------------------------

    if (localFilePath && fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath)
    }

    // ------------------------------------------
    // 6. RESPONSE
    // ------------------------------------------

    return res.json({
      success: true,

      jobId,

      fileName: uploadedFile.originalname,

      chunks: chunks.length,

      transcription,
    })
  } catch (error) {
    console.error("")
    console.error("========================================")
    console.error("ERROR DURANTE LA TRANSCRIPCIÓN")
    console.error("========================================")
    console.error(error)
    console.error("========================================")

    if (localFilePath && fs.existsSync(localFilePath)) {
      try {
        fs.unlinkSync(localFilePath)
      } catch {}
    }

    return res.status(500).json({
      success: false,

      error: "Ocurrió un error al procesar la transcripción.",

      details: error.message,

      jobId,
    })
  } finally {
    // ------------------------------------------
    // CLEAN TEMPORARY FILES
    // ------------------------------------------

    if (processingDirectory) {
      removeDirectory(processingDirectory)
    }
  }
})

// --------------------------------------------------
// CLEAN TRANSCRIPTION
// --------------------------------------------------

const CLEAN_CHUNK_SIZE = 25000

const CLEAN_MAX_CONCURRENCY = 3

const CLEAN_MAX_RETRIES = 3

// --------------------------------------------------
// SPLIT TRANSCRIPT INTO TEXT CHUNKS
// --------------------------------------------------

function splitTranscript(text, maxChars = CLEAN_CHUNK_SIZE) {
  const chunks = []

  let current = ""

  // Intentamos cortar por párrafos/frases,
  // no arbitrariamente en mitad de una palabra.
  const paragraphs = text.split(/\n+/)

  for (const paragraph of paragraphs) {
    const cleanParagraph = paragraph.trim()

    if (!cleanParagraph) {
      continue
    }

    // Si el párrafo individual es demasiado grande,
    // lo cortamos por frases.
    if (cleanParagraph.length > maxChars) {
      const sentences = cleanParagraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [
        cleanParagraph,
      ]

      for (const sentence of sentences) {
        const cleanSentence = sentence.trim()

        if (!cleanSentence) {
          continue
        }

        if (current.length + cleanSentence.length + 1 > maxChars) {
          if (current) {
            chunks.push(current.trim())
          }

          current = cleanSentence
        } else {
          current += " " + cleanSentence
        }
      }

      continue
    }

    if (current.length + cleanParagraph.length + 2 > maxChars) {
      if (current) {
        chunks.push(current.trim())
      }

      current = cleanParagraph
    } else {
      current += (current ? "\n\n" : "") + cleanParagraph
    }
  }

  if (current) {
    chunks.push(current.trim())
  }

  return chunks
}

// --------------------------------------------------
// RETRY HELPER
// --------------------------------------------------

async function runGeminiWithRetry(callback, label) {
  let lastError

  for (let attempt = 1; attempt <= CLEAN_MAX_RETRIES; attempt++) {
    try {
      console.log(`[${label}] Gemini attempt ${attempt}/${CLEAN_MAX_RETRIES}`)

      return await callback()
    } catch (error) {
      lastError = error

      console.error(`[${label}] Error:`, error.message)

      if (attempt < CLEAN_MAX_RETRIES) {
        await sleep(3000 * attempt)
      }
    }
  }

  throw lastError
}

// --------------------------------------------------
// CLEAN ONE TRANSCRIPT CHUNK
// --------------------------------------------------

async function cleanTranscriptChunk(transcriptChunk, chunkNumber) {
  const responseSchema = {
    type: SchemaType.OBJECT,

    properties: {
      cleaned_content: {
        type: SchemaType.STRING,
      },
    },

    required: ["cleaned_content"],
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",

    generationConfig: {
      responseMimeType: "application/json",

      responseSchema,

      temperature: 0,
    },
  })

  const prompt = `
You are cleaning one segment of a conference transcript.

Your ONLY task is to clean the transcript.

Rules:

- Preserve all meaningful spoken content.
- Preserve the original meaning.
- Preserve chronological order.
- Remove filler words such as:
  "um", "uh", "erm", "you know", etc.
- Remove obvious transcription artifacts.
- Remove accidental duplicated words.
- Correct obvious spelling errors.
- Correct obvious transcription mistakes when the intended word is clear.
- Correct obvious split words.
- Preserve technical terminology.
- Preserve names.
- Preserve company names.
- Preserve product names.
- Preserve numbers and statistics.
- Do NOT summarize.
- Do NOT paraphrase.
- Do NOT rewrite the speaker's ideas.
- Do NOT add information.
- Do NOT invent information.
- Do NOT remove meaningful repetition.
- Return ONLY the cleaned transcript.

This is only one part of a larger transcript.
Do not add introductions or conclusions.

Return the cleaned content as a single string.
`

  return runGeminiWithRetry(async () => {
    const result = await model.generateContent([
      {
        text: prompt,
      },
      {
        text: "TRANSCRIPT SEGMENT:\n\n" + transcriptChunk,
      },
    ])

    const raw = result.response.text()

    if (!raw) {
      throw new Error("Gemini returned an empty response.")
    }

    let parsed

    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error("Gemini returned invalid JSON while cleaning chunk.")
    }

    if (!parsed.cleaned_content) {
      throw new Error("Gemini returned empty cleaned_content.")
    }

    console.log(
      `[Clean chunk ${chunkNumber}] Completed (${parsed.cleaned_content.length} chars)`,
    )

    return {
      chunk: chunkNumber,

      cleaned_content: parsed.cleaned_content.trim(),
    }
  }, `Clean chunk ${chunkNumber}`)
}

// --------------------------------------------------
// PROCESS CLEANING CHUNKS
// --------------------------------------------------

async function cleanTranscriptChunks(chunks) {
  const results = new Array(chunks.length)

  let currentIndex = 0

  async function worker(workerId) {
    while (true) {
      const index = currentIndex++

      if (index >= chunks.length) {
        return
      }

      console.log(
        `[Clean worker ${workerId}] Processing chunk ${index + 1}/${chunks.length}`,
      )

      results[index] = await cleanTranscriptChunk(chunks[index], index)
    }
  }

  const workers = Array.from(
    {
      length: Math.min(CLEAN_MAX_CONCURRENCY, chunks.length),
    },
    (_, index) => worker(index + 1),
  )

  await Promise.all(workers)

  return results
}

// --------------------------------------------------
// FINAL SPEAKER EXTRACTION
// --------------------------------------------------

async function extractSpeakers(cleanedTranscript, sheetData) {
  const responseSchema = {
    type: SchemaType.ARRAY,

    items: {
      type: SchemaType.OBJECT,

      properties: {
        id: {
          type: SchemaType.STRING,
        },

        speaker: {
          type: SchemaType.STRING,
        },

        metadata: {
          type: SchemaType.OBJECT,

          properties: {
            conference: {
              type: SchemaType.STRING,
            },

            date: {
              type: SchemaType.STRING,
            },

            title: {
              type: SchemaType.STRING,
            },

            role: {
              type: SchemaType.STRING,
            },

            organization: {
              type: SchemaType.STRING,
            },

            topics: {
              type: SchemaType.ARRAY,

              items: {
                type: SchemaType.STRING,
              },
            },
          },

          required: [
            "conference",
            "date",
            "title",
            "role",
            "organization",
            "topics",
          ],
        },

        cleaned_content: {
          type: SchemaType.STRING,
        },
      },

      required: ["id", "speaker", "metadata", "cleaned_content"],
    },
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",

    generationConfig: {
      responseMimeType: "application/json",

      responseSchema,

      temperature: 0,
    },
  })

  const sheetDataString = JSON.stringify(sheetData, null, 2)

  const prompt = `
You are analyzing a cleaned conference transcript.

Your task is to identify the REAL SPEAKERS who actually speak
and associate them with the provided reference metadata.

IMPORTANT:

The transcript is the source of truth for determining
who actually speaks.

The reference data is ONLY the source of truth for metadata.

Do NOT add people simply because they exist in the reference data.

==================================================
SPEAKER IDENTIFICATION
==================================================

Identify the distinct people who actually speak.

Normally a conference contains approximately 4-5 speakers,
but DO NOT force this number.

If only 3 people actually speak, return 3.

If 4 people speak, return 4.

If 5 people speak, return 5.

Do not invent speakers.

Do not include people who are merely mentioned.

Do not include people who are thanked but never speak.

Do not include hosts.

Do not include moderators.

Do not include interviewers.

Do not include presenters whose contribution consists
only of introducing another speaker.

One person must correspond to exactly one object.

==================================================
IDENTITY
==================================================

Use the transcript to determine speaker identity.

Use the reference metadata to match the identity.

Do not invent surnames.

Do not guess an identity when there is insufficient evidence.

If a speaker cannot be confidently matched to the reference data,
do not invent metadata.

==================================================
CONTENT
==================================================

For each speaker:

Aggregate ALL content belonging to that speaker.

Preserve chronological order.

Remove filler words.

Remove transcription artifacts.

Correct obvious transcription mistakes.

Do not summarize.

Do not paraphrase.

Do not rewrite the speaker.

Do not add information.

Preserve technical terminology.

Preserve names, companies, products, numbers and statistics.

==================================================
METADATA
==================================================

Use the reference data ONLY for:

- conference
- date
- title
- role
- organization

Do not invent missing metadata.

Do not create speakers from reference rows that never speak.

==================================================
TOPICS
==================================================

Generate 10-20 searchable topics based ONLY
on each speaker's actual content.

Avoid generic topics.

==================================================
FINAL VALIDATION
==================================================

Before returning:

- One object per real speaker.
- No duplicate speakers.
- No hosts.
- No moderators.
- No people who only appear in the reference data.
- All content for a speaker is merged.
- Content remains chronological.
- No invented information.
- Valid JSON only.

REFERENCE DATA:

${sheetDataString}

END REFERENCE DATA.
`

  return runGeminiWithRetry(async () => {
    const result = await model.generateContent([
      {
        text: prompt,
      },

      {
        text: "CLEANED TRANSCRIPT:\n\n" + cleanedTranscript,
      },
    ])

    const raw = result.response.text()

    if (!raw) {
      throw new Error("Gemini returned an empty speaker response.")
    }

    let parsed

    try {
      parsed = JSON.parse(raw)
    } catch {
      console.error("Invalid speaker JSON:", raw.substring(0, 2000))

      throw new Error("Gemini returned invalid JSON while extracting speakers.")
    }

    if (!Array.isArray(parsed)) {
      throw new Error("Speaker response is not an array.")
    }

    return parsed
  }, "Speaker extraction")
}

// --------------------------------------------------
// CLEAN TRANSCRIPTION ENDPOINT
// --------------------------------------------------

app.post("/clean-transcription", async (req, res) => {
  console.log("Cleaning transcription request received")

  const { fileName, transcriptionText, sheetData } = req.body

  if (!transcriptionText) {
    return res.status(400).json({
      error: "Missing transcriptionText in the request body.",
    })
  }

  if (!sheetData) {
    return res.status(400).json({
      error: "Missing sheetData in the request body.",
    })
  }

  try {
    // ------------------------------------------
    // 1. SPLIT TRANSCRIPT
    // ------------------------------------------

    const chunks = splitTranscript(transcriptionText)

    console.log(`Transcript split into ${chunks.length} chunks.`)

    console.log(`Original transcript: ${transcriptionText.length} chars`)

    // ------------------------------------------
    // 2. CLEAN CHUNKS
    // ------------------------------------------

    const cleanedChunks = await cleanTranscriptChunks(chunks)

    // ------------------------------------------
    // 3. MERGE CLEANED TRANSCRIPT
    // ------------------------------------------

    const cleanedTranscript = cleanedChunks
      .sort((a, b) => a.chunk - b.chunk)
      .map((chunk) => chunk.cleaned_content)
      .join("\n\n")

    console.log(`Cleaned transcript: ${cleanedTranscript.length} chars`)

    // ------------------------------------------
    // 4. IDENTIFY SPEAKERS
    // ------------------------------------------

    const finalData = await extractSpeakers(cleanedTranscript, sheetData)

    // ------------------------------------------
    // 5. SAFETY DEDUPE
    // ------------------------------------------

    const mergedBySpeaker = new Map()

    for (const entry of finalData) {
      if (!entry) {
        continue
      }

      const speaker =
        typeof entry.speaker === "string" ? entry.speaker.trim() : ""

      if (!speaker) {
        continue
      }

      const key = speaker.toLowerCase().replace(/\s+/g, " ")

      if (
        key === "host" ||
        key === "moderator" ||
        key === "interviewer" ||
        key === "presenter" ||
        key === "unknown"
      ) {
        continue
      }

      if (mergedBySpeaker.has(key)) {
        const existing = mergedBySpeaker.get(key)

        const content = entry.cleaned_content || ""

        if (content) {
          existing.cleaned_content =
            `${existing.cleaned_content}\n\n${content}`.trim()
        }

        existing.metadata.topics = [
          ...new Set([
            ...(existing.metadata?.topics || []),

            ...(entry.metadata?.topics || []),
          ]),
        ]
      } else {
        mergedBySpeaker.set(key, {
          id: entry.id || crypto.randomUUID(),

          speaker,

          metadata: {
            conference: entry.metadata?.conference || "",

            date: entry.metadata?.date || "",

            title: entry.metadata?.title || "",

            role: entry.metadata?.role || "",

            organization: entry.metadata?.organization || "",

            topics: entry.metadata?.topics || [],
          },

          cleaned_content: entry.cleaned_content || "",
        })
      }
    }

    const resultData = Array.from(mergedBySpeaker.values())

    console.log(`Final speakers: ${resultData.length}`)

    // ------------------------------------------
    // 6. RESPONSE
    // ------------------------------------------

    return res.json({
      success: true,

      fileName: `cleaned_transcription_${fileName || "transcription"}.json`,

      speakers: resultData.length,

      data: resultData,
    })
  } catch (error) {
    console.error("Error during the cleaning process:")

    console.error(error)

    return res.status(500).json({
      success: false,

      error: "An error occurred while cleaning the transcription.",

      details: error.message,
    })
  }
})

// --------------------------------------------------
// SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
