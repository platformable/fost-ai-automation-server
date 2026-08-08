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

// Cada chunk tendrá 15 minutos.
// 9 horas ≈ 36 chunks.
const CHUNK_DURATION = 15 * 60

// Número de transcripciones simultáneas.
const MAX_CONCURRENCY = 3

// Número de intentos por chunk.
const MAX_RETRIES = 3

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
// SPLIT AUDIO
// --------------------------------------------------

async function splitAudio(inputPath, outputDirectory) {
  ensureDirectory(outputDirectory)

  console.log("Dividiendo audio con FFmpeg...")

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

    // Crear segmentos
    "-f",
    "segment",

    "-segment_time",
    String(CHUNK_DURATION),

    "-segment_start_number",
    "0",

    path.join(outputDirectory, "chunk_%03d.mp3"),
  ])

  const chunks = fs
    .readdirSync(outputDirectory)
    .filter((file) => file.endsWith(".mp3"))
    .sort()
    .map((file) => path.join(outputDirectory, file))

  console.log(`Audio dividido en ${chunks.length} chunks.`)

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
// TRANSCRIBE ONE CHUNK
// --------------------------------------------------

async function transcribeChunk(filePath, chunkNumber) {
  let lastError

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[Chunk ${chunkNumber}] Transcribiendo...`)

      const file = await uploadToGemini(filePath, chunkNumber)

      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
      })

      const prompt = `
You are a professional conference transcription system.

This audio is ONE SEGMENT of a longer conference recording.

Transcribe ALL spoken content contained in this audio segment.

Rules:

- Preserve the chronological order.
- Do not summarize.
- Do not omit meaningful spoken content.
- Preserve technical terminology.
- Preserve names, numbers, statistics and product names accurately.
- Remove obvious verbal fillers and stutters when they do not add meaning.
- Do not invent information.
- Do not reconstruct missing words or sentences.
- Do not repeat content.
- Do not describe the audio.
- Do not provide commentary.
- Do not provide a summary.
- Return only the transcription.

This is only one segment of a larger recording.
Do not assume this is the beginning or the end of the conference.

Return the clean transcription as plain text.
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

      const transcription = result.response.text()

      if (!transcription) {
        throw new Error("Gemini devolvió una transcripción vacía.")
      }

      console.log(`[Chunk ${chunkNumber}] Transcripción completada.`)

      return {
        chunk: chunkNumber,
        transcription: transcription.trim(),
      }
    } catch (error) {
      lastError = error

      console.error(
        `[Chunk ${chunkNumber}] Error. Intento ${attempt}/${MAX_RETRIES}`,
      )

      console.error(error.message)

      if (attempt < MAX_RETRIES) {
        await sleep(5000 * attempt)
      }
    }
  }

  throw lastError
}

// --------------------------------------------------
// PROCESS CHUNKS WITH CONCURRENCY
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
    // 1. SPLIT AUDIO
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
    // Limpiar chunks temporales
    // después de terminar.

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
