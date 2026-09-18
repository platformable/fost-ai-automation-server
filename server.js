const express = require("express")
const multer = require("multer")
const fs = require("fs")
const path = require("path")
const { promisify } = require("util")

require("dotenv").config()

const { Agent, setGlobalDispatcher } = require("undici")
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai")

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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// --------------------------------------------------
// CONSTANTS
// --------------------------------------------------

// Chunks más pequeños: 30KB en lugar de 100KB
const STEP1_CHUNK = 30000

// --------------------------------------------------
// UTILITY FUNCTIONS
// --------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// --------------------------------------------------
// IMPROVED FUZZY INDEX SEARCH (Cambio 1)
// --------------------------------------------------

function findFuzzyIndex(fullText, quote, searchFromIndex = 0) {
  if (!quote) return -1

  // Normaliza espacios pero mantiene la estructura
  const normalizeQuote = (str) => {
    return str.trim().toLowerCase().replace(/\s+/g, " ")
  }

  const cleanQuote = normalizeQuote(quote)

  // Requiere al menos 15 caracteres significativos
  if (cleanQuote.length < 15) return -1

  // Buscar por palabras, no solo caracteres
  const words = cleanQuote.split(" ")
  const minWordsToMatch = Math.max(3, Math.floor(words.length * 0.7)) // 70% coincidencia

  let currentPos = searchFromIndex

  while (currentPos < fullText.length) {
    // Buscar la primera palabra
    const firstWordIndex = fullText.toLowerCase().indexOf(words[0], currentPos)
    if (firstWordIndex === -1) return -1

    // Extraer contexto alrededor (200 caracteres después)
    const contextEnd = Math.min(firstWordIndex + 200, fullText.length)
    const context = normalizeQuote(
      fullText.substring(firstWordIndex, contextEnd),
    )

    // Contar cuántas palabras coinciden
    let matchedWords = 0
    for (const word of words) {
      if (context.includes(word)) {
        matchedWords++
      }
    }

    // Si coinciden suficientes palabras, es un match
    if (matchedWords >= minWordsToMatch) {
      return firstWordIndex
    }

    currentPos = firstWordIndex + 1
  }

  return -1
}

// --------------------------------------------------
// INTELLIGENT SPEAKER END DETECTION (Cambio 2)
// --------------------------------------------------

function findSpeakerEnd(text, startIndex, speakerName, nextSpeakers = []) {
  if (startIndex < 0 || startIndex >= text.length) return text.length

  // Buscar menciones de los SIGUIENTES speakers
  let closestNextSpeaker = text.length
  for (const nextSpeaker of nextSpeakers) {
    const firstWords = nextSpeaker.split(" ").slice(0, 3).join(" ")
    const idx = text
      .toLowerCase()
      .indexOf(firstWords.toLowerCase(), startIndex + 100)
    if (idx !== -1 && idx < closestNextSpeaker) {
      closestNextSpeaker = idx
    }
  }

  // Límite máximo de longitud (30-40 minutos de audio = 30KB texto)
  const maxSpeakerLength = 30000
  const heuristicEnd = startIndex + maxSpeakerLength

  // Retornar el que sea MENOR
  return Math.min(closestNextSpeaker, heuristicEnd, text.length)
}

// --------------------------------------------------
// CLEAN TEXT IN CHUNKS
// --------------------------------------------------

async function cleanTextInChunks(text, model) {
  const MAX_CHARS = 20000
  let cleanedFullText = ""
  let start = 0
  let chunkIndex = 1

  while (start < text.length) {
    let end = start + MAX_CHARS
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end)
      if (lastSpace > start) end = lastSpace
    }

    const chunk = text.substring(start, end)
    console.log(
      `     -> Limpiando fragmento ${chunkIndex}... (${chunk.length} caracteres)`,
    )

    const cleanPrompt = `Clean the following transcript verbatim. Do NOT summarize or shorten. Fix typos and remove filler words:\n\n${chunk}`

    try {
      const result = await model.generateContent(cleanPrompt)
      cleanedFullText += result.response.text().trim() + "\n\n"
    } catch (e) {
      console.error(`     [Error en fragmento ${chunkIndex}]:`, e.message)
      // Fallback: guardar texto crudo si falla la IA
      cleanedFullText += chunk.trim() + "\n\n"
    }

    start = end
    chunkIndex++
  }
  return cleanedFullText.trim()
}

// --------------------------------------------------
// CLEAN TRANSCRIPTION ENDPOINT - MAIN
// --------------------------------------------------

app.post("/clean-transcription", async (req, res) => {
  console.log("Iniciando limpieza de transcripción...")
  const { fileName, transcriptionText, sheetData } = req.body

  if (!sheetData) {
    return res.status(400).json({ error: "Missing sheetData in request body." })
  }

  if (!transcriptionText) {
    return res
      .status(400)
      .json({ error: "Missing transcriptionText in request body." })
  }

  try {
    const sheetDataString = JSON.stringify(sheetData)

    // =========================================================================
    // PASO 1: Identificación en Bloques (con chunks pequeños)
    // =========================================================================
    const pass1Model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash-lite",
      generationConfig: {
        temperature: 0.0,
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              id: { type: SchemaType.STRING },
              speaker: { type: SchemaType.STRING },
              metadata: {
                type: SchemaType.OBJECT,
                properties: {
                  conference: { type: SchemaType.STRING },
                  date: { type: SchemaType.STRING },
                  title: { type: SchemaType.STRING },
                  role: { type: SchemaType.STRING },
                  organization: { type: SchemaType.STRING },
                  topics: {
                    type: SchemaType.ARRAY,
                    items: { type: SchemaType.STRING },
                  },
                },
              },
              start_quote: {
                type: SchemaType.STRING,
                description: "Primeras 20 palabras exactas",
              },
              end_quote: {
                type: SchemaType.STRING,
                description: "Últimas 20 palabras exactas",
              },
            },
            required: ["id", "speaker", "metadata", "start_quote", "end_quote"],
          },
        },
      },
    })

    let speakerSegments = []

    console.log(
      `\nPaso 1: Mapeando oradores (Texto total: ${transcriptionText.length} caracteres)`,
    )

    for (let i = 0; i < transcriptionText.length; i += STEP1_CHUNK) {
      const textChunk = transcriptionText.substring(i, i + STEP1_CHUNK)
      console.log(
        `\n-> Analizando bloque: pos. ${i} a ${i + textChunk.length}...`,
      )

      const pass1Prompt = `
Analyze this chunk of transcript and identify ALL speakers matching the sheet data: ${sheetDataString}.

CRITICAL RULES FOR ACCURACY:
1. FUZZY MATCHING: Match phonetically, including name variations (Jon/John, Steve/Stephen, etc.)
2. COMPANY/ROLE MATCHING: If a first name + organization matches the sheet, ACCEPT IT.
3. CONTEXT AWARENESS: Look for MC introductions like "Please welcome..." or "Here's..."
4. EXACT QUOTES: Extract FIRST 20 WORDS (start_quote) and LAST 20 WORDS (end_quote) 
   spoken by them IN THIS CHUNK ONLY. These should be EXACT verbatim quotes.
5. ID FORMAT: Sequential "talk-10-munich26", "talk-11-munich26", etc. Date "July 8, 2026" for Day 1.
6. AVOID DUPLICATES: If you find the same speaker multiple times, only report once per chunk.

IMPORTANT: Only return speakers you are CONFIDENT about (>85% certainty).
Return empty array [] if you find no speakers in this chunk.

TRANSCRIPT CHUNK:
${textChunk}

Return ONLY valid JSON array.
`

      try {
        const result = await pass1Model.generateContent(pass1Prompt)
        const chunkSpeakers = JSON.parse(result.response.text())

        // Guardar el texto del bloque y su offset
        chunkSpeakers.forEach((s) => {
          s.chunkOffset = i
          s.chunkText = textChunk
        })

        speakerSegments = speakerSegments.concat(chunkSpeakers)
        console.log(
          `   ✓ Se detectaron ${chunkSpeakers.length} intervención(es).`,
        )
      } catch (e) {
        console.warn(`   [Aviso] Error o sin oradores en este bloque.`)
      }
    }

    console.log(
      `\nPaso 1 completado. Total de intervenciones: ${speakerSegments.length}`,
    )

    // =========================================================================
    // PASO 2: Limpieza Verbatim por Segmento
    // =========================================================================
    const cleanerModel = genAI.getGenerativeModel({
      model: "gemini-3.5-flash-lite",
      systemInstruction: `You are a strict verbatim transcript editor.
CRITICAL DIRECTIVES:
1. NEVER summarize, condense, paraphrase, or rewrite.
2. Every spoken sentence must remain 100% complete.
3. Your ONLY allowed edits are removing filler words (e.g., "um", "uh", "like") and fixing obvious transcription glitches.`,
      generationConfig: { temperature: 0.0 },
    })

    const intermediateData = []
    let idCounter = 10

    for (
      let segmentIdx = 0;
      segmentIdx < speakerSegments.length;
      segmentIdx++
    ) {
      const segment = speakerSegments[segmentIdx]
      console.log(
        `\n--- Extrayendo segmento ${segmentIdx + 1}/${speakerSegments.length}: ${segment.speaker} ---`,
      )

      // Obtener lista de speakers siguientes para detección inteligente de límites
      const nextSpeakers = speakerSegments
        .slice(segmentIdx + 1, segmentIdx + 5)
        .map((s) => s.speaker)

      // Buscar el inicio
      const startIndex = findFuzzyIndex(
        segment.chunkText,
        segment.start_quote,
        0,
      )

      if (startIndex === -1) {
        console.warn(`[Error] No se encontró el inicio. Saltando.`)
        continue
      }

      // Encontrar el final inteligentemente
      const endIndex = findSpeakerEnd(
        segment.chunkText,
        startIndex,
        segment.speaker,
        nextSpeakers,
      )

      // Extraer el texto
      let rawSpeakerText = segment.chunkText.substring(startIndex, endIndex)

      // DEBUG
      console.log(`[DEBUG] ${segment.speaker}:`)
      console.log(`  Start Index: ${startIndex}`)
      console.log(`  End Index: ${endIndex}`)
      console.log(`  Length: ${rawSpeakerText.length} caracteres`)
      console.log(
        `  First 60 chars: "${rawSpeakerText
          .substring(0, 60)
          .replace(/\n/g, " ")}"`,
      )
      console.log(
        `  Last 60 chars: "${rawSpeakerText
          .substring(rawSpeakerText.length - 60)
          .replace(/\n/g, " ")}"`,
      )

      // VALIDAR LONGITUD
      if (rawSpeakerText.length < 200) {
        console.warn(
          `[Error] Texto muy corto (${rawSpeakerText.length} chars). Probablemente falso positivo. Saltando.`,
        )
        continue
      }

      if (rawSpeakerText.length > 50000) {
        console.warn(
          `[Aviso] Texto muy largo (${rawSpeakerText.length} chars). Intentando dividir...`,
        )

        // Intentar dividir por el siguiente speaker
        const nextSpeakerMatch = nextSpeakers[0]
        if (nextSpeakerMatch) {
          const splitIdx = rawSpeakerText
            .toLowerCase()
            .indexOf(nextSpeakerMatch.toLowerCase())
          if (splitIdx > 5000) {
            // Solo dividir si tiene sentido
            rawSpeakerText = rawSpeakerText.substring(0, splitIdx)
            console.log(`   Truncado a ${rawSpeakerText.length} caracteres`)
          }
        }
      }

      console.log(`✓ Texto válido: ${rawSpeakerText.length} caracteres`)

      const cleanedText = await cleanTextInChunks(rawSpeakerText, cleanerModel)

      intermediateData.push({
        id: `talk-${idCounter++}-munich26`,
        speaker: segment.speaker,
        metadata: segment.metadata,
        cleaned_content: cleanedText,
      })
    }

    // =========================================================================
    // PASO 3: Fusionar intervenciones del mismo orador
    // =========================================================================
    console.log(
      "\n--- Fusionando oradores que hablaron en múltiples partes ---",
    )
    const mergedSpeakersMap = {}

    for (const item of intermediateData) {
      if (!mergedSpeakersMap[item.speaker]) {
        mergedSpeakersMap[item.speaker] = item
      } else {
        mergedSpeakersMap[item.speaker].cleaned_content +=
          "\n\n" + item.cleaned_content
      }
    }

    const finalData = Object.values(mergedSpeakersMap)

    console.log(
      `\nProceso completado. ${finalData.length} orador(es) único(s) procesado(s).`,
    )

    res.json({
      success: true,
      fileName: `cleaned_transcription_${fileName}.json`,
      data: finalData,
    })
  } catch (error) {
    console.error("Error durante el proceso:", error)
    res.status(500).json({
      error: "Ocurrió un error al limpiar la transcripción.",
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
