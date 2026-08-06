const dotenv = require("dotenv")
const { GoogleGenAI } = require("@google/genai")
const fs = require("node:fs")
const path = require("node:path")
const { execSync } = require("child_process")

dotenv.config()

// Configuración de rutas y archivos
const AUDIO_ORIGINAL = "french2_0450_9.mp3"
const CARPETA_SALIDA = path.join(__dirname, "french2_0450_9")
const TIEMPO_SEGMENTO = 600 // 10 minutos por pedazo (en segundos)

/**
 * Función encargada de dividir el audio original usando FFmpeg
 * y guardar los fragmentos en la carpeta destino.
 */
function dividirAudioConFFmpeg() {
  // 1. Crear la carpeta si no existe
  if (!fs.existsSync(CARPETA_SALIDA)) {
    fs.mkdirSync(CARPETA_SALIDA, { recursive: true })
    console.log(`📁 Carpeta creada en: ${CARPETA_SALIDA}`)
  } else {
    // Limpiar fragmentos anteriores si ya existían para evitar mezclar audios viejos
    const archivosExistentes = fs.readdirSync(CARPETA_SALIDA)
    for (const archivo of archivosExistentes) {
      fs.unlinkSync(path.join(CARPETA_SALIDA, archivo))
    }
    console.log("🧹 Carpeta de salida limpia y lista para nuevos fragmentos.")
  }

  // 2. Construir la ruta del patrón de nombres de salida
  // Guardará los archivos como: audios_cortados/parte_000.mp3, parte_001.mp3, etc.
  const patronSalida = path.join(
    CARPETA_SALIDA,
    `${path.basename(CARPETA_SALIDA)}_%03d.mp3`,
  )

  console.log("⏳ Dividiendo el archivo de audio original con FFmpeg...")

  try {
    // Ejecutamos FFmpeg indicándole la carpeta de destino exacta
    execSync(
      `ffmpeg -i "${AUDIO_ORIGINAL}" -f segment -segment_time ${TIEMPO_SEGMENTO} -c copy "${patronSalida}"`,
      { stdio: "ignore" },
    )
    console.log("✅ Audio dividido exitosamente en partes de 10 minutos.")
  } catch (error) {
    console.error(
      "❌ Error crítico al ejecutar FFmpeg. Verifica que esté instalado en tu sistema:",
      error.message,
    )
    throw error
  }
}

dividirAudioConFFmpeg()
