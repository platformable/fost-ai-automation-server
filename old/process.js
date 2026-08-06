const { execSync, spawn } = require("child_process")
const fs = require("fs")
const path = require("path")

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const CONFIG = {
  inputDir: "./wavs", // carpeta con los .wav (el directorio actual)
  outputDir: "./output", // carpeta donde se guardan los segmentos
  silenceDuration: 30, // segundos mínimos de silencio para considerar pausa entre conferencias
  silenceThreshold: "-40dB", // sensibilidad del micrófono (más negativo = más estricto)
  minSegmentDuration: 60, // segmentos menores a esto (segundos) se ignoran (aplausos, pausas cortas)
}
// ─────────────────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

function ensureOutputDir() {
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true })
    log(`Carpeta de salida creada: ${CONFIG.outputDir}`)
  }
}

function getWavFiles() {
  return fs
    .readdirSync(CONFIG.inputDir)
    .filter((f) => f.toLowerCase().endsWith(".wav"))
    .map((f) => path.join(CONFIG.inputDir, f))
}

// Detecta silencios en el archivo y devuelve timestamps de corte
function detectSilences(filePath) {
  log(`Analizando silencios en: ${path.basename(filePath)}`)

  const cmd = [
    "ffmpeg",
    "-i",
    filePath,
    "-af",
    `silencedetect=noise=${CONFIG.silenceThreshold}:d=${CONFIG.silenceDuration}`,
    "-f",
    "null",
    "-",
  ]

  let output = ""
  try {
    // ffmpeg escribe esto a stderr
    output = execSync(cmd.join(" "), {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (err) {
    output = err.stderr || err.stdout || ""
  }

  const silences = []
  const startRegex = /silence_start:\s*([\d.]+)/g
  const endRegex =
    /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g

  let startMatch
  while ((startMatch = startRegex.exec(output)) !== null) {
    silences.push({ start: parseFloat(startMatch[1]) })
  }

  let endMatch
  let i = 0
  while ((endMatch = endRegex.exec(output)) !== null) {
    if (silences[i]) {
      silences[i].end = parseFloat(endMatch[1])
      silences[i].duration = parseFloat(endMatch[2])
      i++
    }
  }

  log(`  → ${silences.length} silencios detectados`)
  return silences.filter((s) => s.end !== undefined)
}

// A partir de los silencios, calcula los segmentos de conferencia
function calculateSegments(silences, totalDuration) {
  const cutPoints = [0]

  for (const silence of silences) {
    // El corte es en el punto medio del silencio
    const midpoint = (silence.start + silence.end) / 2
    cutPoints.push(midpoint)
  }

  cutPoints.push(totalDuration)

  const segments = []
  for (let i = 0; i < cutPoints.length - 1; i++) {
    const start = cutPoints[i]
    const end = cutPoints[i + 1]
    const duration = end - start

    if (duration >= CONFIG.minSegmentDuration) {
      segments.push({ start, end, duration })
    }
  }

  return segments
}

// Obtiene la duración total del archivo
function getDuration(filePath) {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { encoding: "utf8" },
    )
    return parseFloat(output.trim())
  } catch (err) {
    log(`  ⚠ No se pudo obtener duración: ${err.message}`)
    return null
  }
}

// Exporta un segmento como archivo wav
function exportSegment(inputFile, segment, outputFile) {
  const cmd = [
    "ffmpeg",
    "-y", // sobreescribir si existe
    "-i",
    `"${inputFile}"`,
    "-ss",
    segment.start.toFixed(3),
    "-to",
    segment.end.toFixed(3),
    "-c",
    "copy", // sin re-encodear, más rápido
    `"${outputFile}"`,
  ].join(" ")

  execSync(cmd, { stdio: "pipe" })
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0")
  const m = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0")
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")
  return `${h}:${m}:${s}`
}

// Procesa un archivo wav completo
function processFile(filePath) {
  const baseName = path.basename(filePath, ".wav")
  log(`\n${"═".repeat(60)}`)
  log(`Procesando: ${baseName}.wav`)

  const totalDuration = getDuration(filePath)
  if (!totalDuration) {
    log("  ✗ No se pudo procesar este archivo, saltando...")
    return null
  }

  log(`  Duración total: ${formatTime(totalDuration)}`)

  const silences = detectSilences(filePath)
  const segments = calculateSegments(silences, totalDuration)

  log(`  → ${segments.length} conferencias detectadas`)

  const metadata = {
    sourceFile: path.basename(filePath),
    totalDuration,
    totalDurationFormatted: formatTime(totalDuration),
    conferencesDetected: segments.length,
    conferences: [],
  }

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const outputFileName = `${baseName}_conferencia_${String(i + 1).padStart(2, "0")}.wav`
    const outputPath = path.join(CONFIG.outputDir, outputFileName)

    log(
      `  Exportando conferencia ${i + 1}/${segments.length}: ${formatTime(segment.start)} → ${formatTime(segment.end)} (${formatTime(segment.duration)})`,
    )

    try {
      exportSegment(filePath, segment, outputPath)

      metadata.conferences.push({
        index: i + 1,
        outputFile: outputFileName,
        startSeconds: segment.start,
        endSeconds: segment.end,
        durationSeconds: segment.duration,
        start: formatTime(segment.start),
        end: formatTime(segment.end),
        duration: formatTime(segment.duration),
      })

      log(`    ✓ Guardado: ${outputFileName}`)
    } catch (err) {
      log(`    ✗ Error exportando: ${err.message}`)
    }
  }

  return metadata
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
function main() {
  console.log("\n🎙  Procesador de conferencias en audio WAV")
  console.log("════════════════════════════════════════════\n")

  // Verificar que ffmpeg esté instalado
  try {
    execSync("ffmpeg -version", { stdio: "pipe" })
    execSync("ffprobe -version", { stdio: "pipe" })
  } catch {
    console.error("❌ ERROR: ffmpeg no está instalado o no está en el PATH.")
    console.error(
      "   Instálalo con: brew install ffmpeg (Mac) o apt install ffmpeg (Linux)",
    )
    process.exit(1)
  }

  ensureOutputDir()

  const wavFiles = getWavFiles()
  if (wavFiles.length === 0) {
    log("No se encontraron archivos .wav en el directorio actual.")
    process.exit(0)
  }

  log(`Archivos .wav encontrados: ${wavFiles.length}`)

  const allMetadata = []

  for (const filePath of wavFiles) {
    const metadata = processFile(filePath)
    if (metadata) allMetadata.push(metadata)
  }

  // Guardar metadata JSON para usar en el RAG
  const metadataPath = path.join(CONFIG.outputDir, "metadata.json")
  fs.writeFileSync(metadataPath, JSON.stringify(allMetadata, null, 2), "utf8")

  console.log(`\n${"═".repeat(60)}`)
  console.log("✅ Proceso completado")
  console.log(`   Archivos generados en: ${CONFIG.outputDir}`)
  console.log(`   Metadata guardada en:  ${metadataPath}`)

  const totalConferences = allMetadata.reduce(
    (sum, m) => sum + m.conferencesDetected,
    0,
  )
  console.log(`   Total de conferencias extraídas: ${totalConferences}`)
  console.log("")
}

main()
