const express = require("express")
const multer = require("multer")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { execFile } = require("child_process")
const { promisify } = require("util")

require("dotenv").config()

const { Agent, setGlobalDispatcher } = require("undici")

const { GoogleGenerativeAI } = require("@google/generative-ai")

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

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const PORT = process.env.PORT || 3000

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

app.post("/clean-transcription", async (req, res) => {
  console.log("Cleaning transcription request received")

  const { fileName, transcriptionText, sheetData } = req.body

  // --------------------------------------------------
  // VALIDATION
  // --------------------------------------------------

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
    console.log(`Transcript length: ${transcriptionText.length} characters`)

    console.log(
      `Metadata rows: ${
        Array.isArray(sheetData) ? sheetData.length : "unknown"
      }`,
    )

    // --------------------------------------------------
    // RESPONSE SCHEMA
    // --------------------------------------------------

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

    // --------------------------------------------------
    // MODEL
    // --------------------------------------------------

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",

      generationConfig: {
        responseMimeType: "application/json",

        responseSchema,

        temperature: 0,
      },
    })

    // --------------------------------------------------
    // METADATA
    // --------------------------------------------------

    const sheetDataString = JSON.stringify(sheetData, null, 2)

    // --------------------------------------------------
    // PROMPT
    // --------------------------------------------------

    const prompt = `
You are processing a transcript of a conference talk.

Your task is to identify the REAL SPEAKERS who actually speak
in the transcript, clean their spoken content, and match each
speaker with metadata from the provided reference data.

Follow the steps EXACTLY in this order.

==================================================
STEP 1 — IDENTIFY REAL SPEAKERS
==================================================

Determine how many DISTINCT PEOPLE actually speak in the transcript.

IMPORTANT:

- Identify speakers ONLY from the transcript.
- Do NOT use the spreadsheet/reference data to decide who speaks.
- The reference data is ONLY for metadata matching.
- Only include people who actually have spoken content.
- Do NOT include people who are merely mentioned.
- Do NOT include people who are thanked but never speak.
- Do NOT include audience members who do not have meaningful spoken turns.
- Do NOT create one object per spreadsheet row.
- Do NOT create duplicate objects for the same speaker.
- One person = one object.

HOST / MODERATOR:

- Do NOT include hosts.
- Do NOT include moderators.
- Do NOT include interviewers.
- Do NOT include presenters whose only role is introducing another speaker.
- If someone acts as both host and speaker, determine from their actual
  contribution whether they are a real speaker for the talk.
- Do not create an object named "Host", "Moderator", "Interviewer",
  "Presenter" or "Unknown".

If a person's name cannot be determined reliably from the transcript,
do NOT invent a name.

==================================================
STEP 2 — CLEAN EACH SPEAKER'S CONTENT
==================================================

For each real speaker:

- Remove filler words such as:
  "um", "uh", "erm", "you know", etc.
- Remove obvious transcription artifacts.
- Remove duplicated words caused by transcription errors.
- Correct obvious spelling errors.
- Correct obvious transcription mistakes when the intended word
  is unambiguous.
- Correct obvious split words.
- Preserve technical terminology.
- Preserve product names.
- Preserve company names.
- Preserve numbers and statistics.
- Preserve the speaker's meaning.
- Preserve the speaker's original wording as much as possible.

DO NOT:

- Rewrite the speaker.
- Paraphrase.
- Summarize.
- Improve their arguments.
- Make the language more professional.
- Add information.
- Remove meaningful repetitions that are intentionally spoken.

The result should read like a clean transcript of what the speaker
actually said.

==================================================
STEP 3 — AGGREGATE EACH SPEAKER
==================================================

A speaker may appear many times throughout the transcript.

Merge ALL of that speaker's spoken segments into ONE
"cleaned_content" string.

The content MUST remain chronological.

Example:

Speaker A:
[first section]
[later section]
[final section]

All three sections must become one cleaned_content.

Do NOT create:

Speaker A #1
Speaker A #2
Speaker A #3

There must be exactly ONE object for Speaker A.

==================================================
STEP 4 — MATCH METADATA
==================================================

Use the reference data below ONLY to match metadata.

Match speakers by name similarity.

The transcript is the source of truth for:
- Who actually speaks.
- How many speakers exist.
- What each person actually said.

The reference data is the source of truth for:
- conference
- date
- title
- role
- organization

DO NOT:

- Add people because they exist in the reference data.
- Assume that every person in the reference data speaks.
- Invent missing metadata.
- Guess a person's identity when the match is uncertain.

If a speaker cannot be matched confidently to the reference data,
keep the speaker but leave unmatched metadata fields empty.

==================================================
STEP 5 — TOPICS
==================================================

Generate 10-20 highly relevant and searchable topic tags
for each speaker.

Topics MUST be based ONLY on that speaker's actual content.

Good topics are things such as:

- API design
- API security
- developer experience
- microservices
- observability
- distributed systems

Do NOT generate generic topics such as:

- conference
- technology
- software
- programming

unless they are genuinely relevant.

==================================================
STEP 6 — FINAL VALIDATION
==================================================

Before returning the result:

- Every object must represent a person who actually speaks.
- No hosts.
- No moderators.
- No people who are merely mentioned.
- No duplicate speakers.
- All content belonging to the same speaker must be merged.
- Preserve chronological order within cleaned_content.
- Do not invent content.
- Do not invent names.
- Do not invent metadata.
- Return ONLY valid JSON matching the requested schema.

REFERENCE DATA
==============

${sheetDataString}

END REFERENCE DATA
`

    // --------------------------------------------------
    // GEMINI REQUEST
    // --------------------------------------------------

    console.log("Sending transcript to Gemini for cleaning...")

    const result = await model.generateContent([
      {
        text: prompt,
      },

      {
        text: "TRANSCRIPT TO CLEAN:\n\n" + transcriptionText,
      },
    ])

    // --------------------------------------------------
    // PARSE RESULT
    // --------------------------------------------------

    const rawResult = result.response.text()

    if (!rawResult) {
      throw new Error("Gemini returned an empty response.")
    }

    console.log("Gemini cleaning completed.")

    let finalData

    try {
      finalData = JSON.parse(rawResult)
    } catch (parseError) {
      console.error("Failed to parse Gemini JSON:", rawResult)

      throw new Error("Gemini returned invalid JSON.")
    }

    // --------------------------------------------------
    // SAFETY VALIDATION
    // --------------------------------------------------

    if (!Array.isArray(finalData)) {
      throw new Error("Gemini response is not an array.")
    }

    // --------------------------------------------------
    // DEDUPLICATE SPEAKERS
    // --------------------------------------------------

    const originalCount = finalData.length

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

      // ----------------------------------------------
      // Ignore obvious host/moderator entries
      // ----------------------------------------------

      const normalizedSpeaker = speaker
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()

      if (
        normalizedSpeaker === "host" ||
        normalizedSpeaker === "moderator" ||
        normalizedSpeaker === "interviewer" ||
        normalizedSpeaker === "presenter" ||
        normalizedSpeaker === "unknown"
      ) {
        console.warn(`Skipping non-speaker entry: ${speaker}`)

        continue
      }

      // ----------------------------------------------
      // Speaker matching key
      // ----------------------------------------------

      const key = normalizedSpeaker

      // ----------------------------------------------
      // Normalize metadata
      // ----------------------------------------------

      const metadata = entry.metadata || {}

      const normalizedMetadata = {
        conference: metadata.conference || "",

        date: metadata.date || "",

        title: metadata.title || "",

        role: metadata.role || "",

        organization: metadata.organization || "",

        topics: Array.isArray(metadata.topics) ? metadata.topics : [],
      }

      // ----------------------------------------------
      // Content
      // ----------------------------------------------

      const content =
        typeof entry.cleaned_content === "string"
          ? entry.cleaned_content.trim()
          : ""

      // ----------------------------------------------
      // MERGE DUPLICATES
      // ----------------------------------------------

      if (mergedBySpeaker.has(key)) {
        const existing = mergedBySpeaker.get(key)

        if (content) {
          existing.cleaned_content =
            `${existing.cleaned_content}\n\n${content}`.trim()
        }

        existing.metadata.topics = [
          ...new Set([
            ...(existing.metadata.topics || []),
            ...normalizedMetadata.topics,
          ]),
        ]

        // Fill missing metadata
        // without overwriting existing
        // values with empty values.

        for (const field of [
          "conference",
          "date",
          "title",
          "role",
          "organization",
        ]) {
          if (!existing.metadata[field] && normalizedMetadata[field]) {
            existing.metadata[field] = normalizedMetadata[field]
          }
        }
      } else {
        mergedBySpeaker.set(key, {
          id: entry.id || crypto.randomUUID(),

          speaker,

          metadata: normalizedMetadata,

          cleaned_content: content,
        })
      }
    }

    finalData = Array.from(mergedBySpeaker.values())

    // --------------------------------------------------
    // LOGGING
    // --------------------------------------------------

    if (finalData.length !== originalCount) {
      console.warn(
        `⚠️ Speaker dedupe: Gemini returned ${originalCount} objects, merged to ${finalData.length}.`,
      )
    }

    console.log(`Final speakers: ${finalData.length}`)

    // --------------------------------------------------
    // RESPONSE
    // --------------------------------------------------

    return res.json({
      success: true,

      fileName: `cleaned_transcription_${fileName || "transcription"}.json`,

      speakers: finalData.length,

      data: finalData,
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
