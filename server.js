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
const CHUNK_DURATION = 5 * 60

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
  // 1. CLEAN AUDIO
  // ------------------------------------------

  await cleanAudio(inputPath, cleanedAudioPath)

  // ------------------------------------------
  // 2. SPLIT AUDIO
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

    // IMPORTANTE:
    // Cada chunk se codifica como un archivo
    // independiente.
    "-c:a",
    "libmp3lame",

    "-b:a",
    "64k",

    "-ar",
    "16000",

    "-ac",
    "1",

    "-y",

    path.join(outputDirectory, "chunk_%03d.mp3"),
  ])

  // ------------------------------------------
  // 3. FIND ACTUAL CHUNKS
  // ------------------------------------------

  const chunks = fs
    .readdirSync(outputDirectory)
    .filter((file) => /^chunk_\d+\.mp3$/.test(file))
    .sort((a, b) => {
      const aNumber = parseInt(a.match(/\d+/)[0], 10)

      const bNumber = parseInt(b.match(/\d+/)[0], 10)

      return aNumber - bNumber
    })
    .map((file) => path.join(outputDirectory, file))

  // ------------------------------------------
  // 4. VERIFY FILES
  // ------------------------------------------

  console.log("")
  console.log(`FFmpeg generó ${chunks.length} chunks.`)

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]

    const stats = fs.statSync(chunk)

    console.log(
      `[Chunk ${i}] ${path.basename(chunk)} - ${(
        stats.size /
        1024 /
        1024
      ).toFixed(2)} MB`,
    )

    if (stats.size === 0) {
      throw new Error(`Chunk vacío: ${chunk}`)
    }
  }

  if (chunks.length === 0) {
    throw new Error("FFmpeg no generó ningún chunk.")
  }

  return chunks
}

// --------------------------------------------------
// UPLOAD TO GEMINI
// --------------------------------------------------

async function uploadToGemini(filePath, chunkNumber) {
  // ------------------------------------------
  // VERIFY LOCAL FILE
  // ------------------------------------------

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `El archivo del chunk ${chunkNumber} no existe: ${filePath}`,
    )
  }

  const stats = fs.statSync(filePath)

  if (stats.size === 0) {
    throw new Error(
      `El archivo del chunk ${chunkNumber} está vacío: ${filePath}`,
    )
  }

  console.log(`[Chunk ${chunkNumber}] Subiendo a Gemini...`)

  const response = await fileManager.uploadFile(filePath, {
    mimeType: "audio/mpeg",

    displayName: `conference_chunk_${String(chunkNumber).padStart(3, "0")}.mp3`,
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
  if (!text) {
    return false
  }

  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

  const words = normalized.split(" ").filter(Boolean)

  // Una transcripción de 5 minutos debería
  // tener bastantes palabras, pero no queremos
  // analizar textos pequeños.
  if (words.length < 100) {
    return false
  }

  // ------------------------------------------------
  // 1. Detectar una frase de 5 palabras repetida
  // muchas veces dentro del texto.
  // ------------------------------------------------

  const N = 5

  const occurrences = new Map()

  for (let i = 0; i <= words.length - N; i++) {
    const phrase = words.slice(i, i + N).join(" ")

    const positions = occurrences.get(phrase) || []

    positions.push(i)

    occurrences.set(phrase, positions)
  }

  for (const [phrase, positions] of occurrences) {
    if (positions.length < 15) {
      continue
    }

    // Comprobar si las apariciones están
    // muy concentradas.
    const first = positions[0]
    const last = positions[positions.length - 1]

    const span = last - first

    // Si una misma frase aparece 15+ veces
    // en menos de 2000 palabras, es extremadamente
    // sospechoso.
    if (positions.length >= 15 && span < 2000) {
      console.warn(
        `⚠️ Repetición sospechosa detectada: "${phrase}" (${positions.length} veces)`,
      )

      return true
    }
  }

  // ------------------------------------------------
  // 2. Detectar bloques repetidos
  // ------------------------------------------------

  const BLOCK_SIZE = 10

  for (let i = 0; i < words.length - BLOCK_SIZE * 3; i++) {
    const block1 = words.slice(i, i + BLOCK_SIZE).join(" ")

    const block2 = words.slice(i + BLOCK_SIZE, i + BLOCK_SIZE * 2).join(" ")

    const block3 = words.slice(i + BLOCK_SIZE * 2, i + BLOCK_SIZE * 3).join(" ")

    if (block1 === block2 && block2 === block3) {
      console.warn("⚠️ Bloque de texto repetido 3 veces consecutivas.")

      return true
    }
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

      // ------------------------------------------
      // UPLOAD
      // ------------------------------------------

      const file = await uploadToGemini(filePath, chunkNumber)

      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
      })

      // ------------------------------------------
      // PROMPT
      // ------------------------------------------

      let prompt

      if (attempt === 1) {
        prompt = `
Generate a faithful transcript of the speech
actually present in this audio segment.

Process the audio strictly once, from beginning
to end.

IMPORTANT:
Never repeat a phrase, sentence, paragraph or
section that you have already transcribed.

Do not continue generating text after the audio
content has ended.

Do not infer or invent speech.

Use ONLY the audio supplied in this request.

Return ONLY the transcript.
`
      } else if (attempt === 2) {
        prompt = `
Transcribe ONLY the human speech that is actually
audible in this audio segment.

Process the audio sequentially from start to finish.

Each spoken passage must appear exactly once.

IMPORTANT:
If you notice that you are generating the same
sentence or phrase repeatedly, STOP and continue
with the next part of the audio.

Never loop.

Never repeat previously transcribed content.

Do not use outside knowledge.

Do not invent missing words.

Return ONLY the transcript.
`
      } else {
        prompt = `
Produce a clean chronological transcription of
this audio segment.

Use only the supplied audio.

This is one segment of a larger conference.

Do not summarize.

Do not repeat.

Do not hallucinate.

Do not reconstruct speech that is not audible.

Every part of the spoken audio must be represented
at most once.

If the audio contains silence or unintelligible
content, omit it.

Return ONLY the transcription.
`
      }

      // ------------------------------------------
      // GENERATION CONFIG
      // ------------------------------------------

      const temperature = attempt === 1 ? 0 : attempt === 2 ? 0.1 : 0.2

      // ------------------------------------------
      // GEMINI REQUEST
      // ------------------------------------------

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
          temperature,
        },
      })

      // ------------------------------------------
      // CHECK GEMINI CANDIDATE
      // ------------------------------------------

      const candidate = result.response?.candidates?.[0]

      const finishReason = candidate?.finishReason

      console.log(
        `[Chunk ${chunkNumber}] Finish reason: ${finishReason || "NONE"}`,
      )

      // ------------------------------------------
      // RECITATION
      // ------------------------------------------

      if (finishReason === "RECITATION") {
        console.warn("")
        console.warn(
          `⚠️ [Chunk ${chunkNumber}] Gemini bloqueó la respuesta por RECITATION.`,
        )

        console.warn(
          `[Chunk ${chunkNumber}] Se utilizará un prompt alternativo en el siguiente intento.`,
        )

        throw new Error("GEMINI_RECITATION")
      }

      // ------------------------------------------
      // OTHER BLOCKED RESPONSES
      // ------------------------------------------

      if (
        finishReason === "SAFETY" ||
        finishReason === "BLOCKLIST" ||
        finishReason === "PROHIBITED_CONTENT"
      ) {
        throw new Error(`GEMINI_BLOCKED_${finishReason}`)
      }

      // ------------------------------------------
      // GET TEXT
      // ------------------------------------------

      let transcription

      try {
        transcription = result.response.text().trim()
      } catch (responseError) {
        console.error(`[Chunk ${chunkNumber}] Gemini no pudo devolver texto.`)

        console.error(responseError)

        throw responseError
      }

      // ------------------------------------------
      // EMPTY RESPONSE
      // ------------------------------------------

      if (!transcription) {
        console.log(`[Chunk ${chunkNumber}] Gemini no detectó habla.`)

        return {
          chunk: chunkNumber,

          transcription: "",
        }
      }

      // ------------------------------------------
      // REPETITION DETECTION
      // ------------------------------------------

      const suspicious = detectSuspiciousRepetition(transcription)

      if (suspicious) {
        console.warn(
          `[Chunk ${chunkNumber}] Gemini produjo una transcripción sospechosamente repetitiva.`,
        )

        throw new Error("GEMINI_REPETITIVE_OUTPUT")
      }

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

      // ------------------------------------------
      // RETRY
      // ------------------------------------------

      if (attempt < MAX_RETRIES) {
        const waitTime =
          error.message === "GEMINI_RECITATION"
            ? 3000
            : error.message === "GEMINI_REPETITIVE_OUTPUT"
              ? 3000
              : 5000 * attempt

        console.log(
          `[Chunk ${chunkNumber}] Reintentando en ${
            waitTime / 1000
          } segundos...`,
        )

        await sleep(waitTime)
      }
    }
  }

  // ------------------------------------------
  // ALL ATTEMPTS FAILED
  // ------------------------------------------

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

    console.log("")
    console.log("Verificando chunks antes de comenzar Gemini...")

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]

      if (!fs.existsSync(chunk)) {
        throw new Error(
          `Chunk desapareció antes de comenzar la transcripción: ${chunk}`,
        )
      }

      const stats = fs.statSync(chunk)

      if (stats.size === 0) {
        throw new Error(
          `Chunk vacío antes de comenzar la transcripción: ${chunk}`,
        )
      }

      console.log(
        `[VERIFY ${i}] ${path.basename(chunk)} - ${(
          stats.size /
          1024 /
          1024
        ).toFixed(2)} MB`,
      )
    }

    console.log(`Todos los ${chunks.length} chunks están disponibles.`)

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
    console.error("Error type:", error.message)

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
      console.log(`Processing directory: ${processingDirectory}`)
    }
  }
})

// --------------------------------------------------
// CLEAN TRANSCRIPTION
// --------------------------------------------------

const CLEAN_CHUNK_SIZE = 25000

const CLEAN_MAX_CONCURRENCY = 1

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
