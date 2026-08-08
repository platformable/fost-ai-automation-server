const express = require("express")
const multer = require("multer")
const fs = require("fs")
const path = require("path")
const { execFile } = require("child_process")
const { promisify } = require("util")
const crypto = require("crypto")

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
// CONFIGURACIÓN DEL PROCESAMIENTO
// --------------------------------------------------

const CHUNK_DURATION = 15 * 60 // 15 minutos

const MAX_CONCURRENCY = 3

const MAX_RETRIES = 3

// --------------------------------------------------
// UTILS
// --------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
// FFMPEG
// --------------------------------------------------

async function splitAudio(inputPath, outputDirectory) {
  ensureDirectory(outputDirectory)

  console.log("Iniciando FFmpeg...")

  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",

    "-i",
    inputPath,

    // Mono
    "-ac",
    "1",

    // 16 kHz
    "-ar",
    "16000",

    // MP3 optimizado para voz
    "-c:a",
    "libmp3lame",

    "-b:a",
    "64k",

    // Segmentar cada 15 minutos
    "-f",
    "segment",

    "-segment_time",
    String(CHUNK_DURATION),

    // Nombres
    "-segment_start_number",
    "0",

    path.join(outputDirectory, "chunk_%03d.mp3"),
  ])

  const chunks = fs
    .readdirSync(outputDirectory)
    .filter((file) => file.endsWith(".mp3"))
    .sort()
    .map((file) => path.join(outputDirectory, file))

  console.log(`FFmpeg terminó. ${chunks.length} chunks creados.`)

  return chunks
}

// --------------------------------------------------
// GEMINI
// --------------------------------------------------

const transcriptionSchema = {
  type: SchemaType.OBJECT,

  properties: {
    segments: {
      type: SchemaType.ARRAY,

      items: {
        type: SchemaType.OBJECT,

        properties: {
          start: {
            type: SchemaType.NUMBER,
          },

          end: {
            type: SchemaType.NUMBER,
          },

          speaker: {
            type: SchemaType.STRING,
          },

          text: {
            type: SchemaType.STRING,
          },
        },

        required: ["start", "end", "speaker", "text"],
      },
    },
  },

  required: ["segments"],
}

// --------------------------------------------------
// SUBIR ARCHIVO A GEMINI
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
    throw new Error(`Gemini falló procesando chunk ${chunkNumber}`)
  }

  return fileState
}

// --------------------------------------------------
// TRANSCRIBIR CHUNK
// --------------------------------------------------

async function transcribeChunk(filePath, chunkNumber) {
  const startTime = chunkNumber * CHUNK_DURATION

  console.log(`[Chunk ${chunkNumber}] Iniciando transcripción...`)

  const file = await uploadToGemini(filePath, chunkNumber)

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
  })

  const prompt = `
You are a professional conference transcription system.

This audio is ONE SEGMENT of a much longer conference recording.

Transcribe ONLY the speech contained in this audio segment.

IMPORTANT:

1. Preserve the chronological order.
2. Do not summarize.
3. Do not invent missing information.
4. Do not repeat content.
5. Preserve technical terminology.
6. Preserve names, numbers, statistics and product names.
7. Identify different speakers.
8. If the real identity of a speaker is unknown, use:
   SPEAKER_01
   SPEAKER_02
   SPEAKER_03
   etc.
9. Do not guess the real names of speakers.
10. Remove obvious verbal fillers such as "um", "uh", etc. when they do not add meaning.
11. Do not remove meaningful content.
12. Provide timestamps relative to the beginning of THIS audio segment.
13. Start timestamps at approximately 0 seconds.
14. End timestamps at the actual end of the spoken segment.
15. Do not create timestamps for silence.
16. Return every meaningful spoken section.
17. Do not describe the audio.
18. Do not provide a summary.

The timestamps MUST be expressed as numbers in seconds.

For example:

{
  "segments": [
    {
      "start": 12.4,
      "end": 25.8,
      "speaker": "SPEAKER_01",
      "text": "This is the actual transcription."
    }
  ]
}

Return ONLY the structured transcription.
`

  let lastError

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
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
          responseMimeType: "application/json",

          responseSchema: transcriptionSchema,

          temperature: 0,
        },
      })

      const text = result.response.text()

      const parsed = JSON.parse(text)

      // Convert timestamps from
      // chunk-relative to global timestamps.
      const segments = parsed.segments.map((segment) => ({
        start: Number((startTime + segment.start).toFixed(3)),

        end: Number((startTime + segment.end).toFixed(3)),

        speaker: segment.speaker,

        text: segment.text.trim(),
      }))

      console.log(`[Chunk ${chunkNumber}] Transcripción completada.`)

      return {
        chunk: chunkNumber,
        startTime,
        segments,
      }
    } catch (error) {
      lastError = error

      console.error(
        `[Chunk ${chunkNumber}] Error en intento ${attempt}/${MAX_RETRIES}:`,
        error.message,
      )

      if (attempt < MAX_RETRIES) {
        await sleep(5000 * attempt)
      }
    }
  }

  throw lastError
}

// --------------------------------------------------
// PROCESAMIENTO CONCURRENTE
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

      const chunkPath = chunks[index]

      console.log(`[Worker ${workerId}] Procesando chunk ${index}`)

      try {
        results[index] = await transcribeChunk(chunkPath, index)
      } catch (error) {
        console.error(
          `[Worker ${workerId}] Chunk ${index} falló definitivamente.`,
        )

        throw error
      }
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
// MERGE
// --------------------------------------------------

function mergeTranscriptions(results) {
  const segments = results
    .sort((a, b) => a.chunk - b.chunk)
    .flatMap((result) => result.segments)

  return {
    segments,
  }
}

// --------------------------------------------------
// ENDPOINT
// --------------------------------------------------

app.post("/transcribe", upload.any(), async (req, res) => {
  const jobId = crypto.randomUUID()

  let localFilePath
  let processingDirectory

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: "No se recibió ningún archivo de audio.",
      })
    }

    const uploadedFile = req.files[0]

    localFilePath = uploadedFile.path

    processingDirectory = path.join("processing", jobId)

    ensureDirectory(processingDirectory)

    console.log("========================================")

    console.log(`JOB: ${jobId}`)

    console.log(`Archivo: ${uploadedFile.originalname}`)

    console.log(`MIME: ${uploadedFile.mimetype}`)

    console.log("========================================")

    // ------------------------------------------
    // 1. DIVIDIR AUDIO
    // ------------------------------------------

    const chunks = await splitAudio(localFilePath, processingDirectory)

    // ------------------------------------------
    // 2. TRANSCRIBIR
    // ------------------------------------------

    const results = await processChunks(chunks)

    // ------------------------------------------
    // 3. MERGE
    // ------------------------------------------

    const transcript = mergeTranscriptions(results)

    // ------------------------------------------
    // 4. GUARDAR JSON
    // ------------------------------------------

    const outputFile = path.join(
      processingDirectory,
      `transcripcion_${jobId}.json`,
    )

    fs.writeFileSync(outputFile, JSON.stringify(transcript, null, 2))

    console.log(`Transcripción completa: ${outputFile}`)

    // ------------------------------------------
    // 5. LIMPIAR AUDIO ORIGINAL
    // ------------------------------------------

    if (localFilePath && fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath)
    }

    // ------------------------------------------
    // 6. RESPUESTA
    // ------------------------------------------

    return res.json({
      success: true,

      jobId,

      fileName: uploadedFile.originalname,

      chunks: chunks.length,

      segments: transcript.segments.length,

      transcription: transcript,
    })
  } catch (error) {
    console.error("========================================")

    console.error("ERROR DE TRANSCRIPCIÓN")

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
    // Eliminamos los chunks después
    // de terminar el procesamiento.
    //
    // Si quieres conservarlos para debugging,
    // puedes comentar esta línea.

    if (processingDirectory) {
      removeDirectory(processingDirectory)
    }
  }
})

// --------------------------------------------------
// SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
