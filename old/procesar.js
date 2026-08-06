const { GoogleGenerativeAI } = require("@google/generative-ai")
const { GoogleAIFileManager } = require("@google/generative-ai/server")
const fs = require("node:fs")
const path = require("node:path")
const dotenv = require("dotenv")
// Asegúrate de poner tu API Key en las variables de entorno
dotenv.config()

const apiKey = process.env.GEMINI_API_KEY

// Inicializamos el File Manager (para subir el archivo) y el modelo
const fileManager = new GoogleAIFileManager(apiKey)
const genAI = new GoogleGenerativeAI(apiKey)

async function transcribirAudioLargo() {
  const rutaArchivo = "./LIN20260213093637_comprimido.mp3"

  try {
    console.log("1. Subiendo el archivo de audio a Gemini...")
    // Esto lo sube a la nube temporal de Google (soporta hasta 2 GB)
    const uploadResult = await fileManager.uploadFile(rutaArchivo, {
      mimeType: "audio/mp3",
      displayName: "Conferencia Principal",
    })
    console.log(`✅ Archivo subido con éxito: ${uploadResult.file.uri}`)

    console.log(
      "2. Procesando la transcripción con Gemini Flash (esto puede tardar unos minutos)...",
    )

    // Instanciamos Gemini Flash
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" })

    const prompt = `
      Te estoy pasando un audio largo que contiene varias conferencias separadas por silencios. 
      Transcribe el contenido hablado de forma detallada.
      Ignora los silencios y la música de fondo. 
      Separa claramente la transcripción de cada conferencia usando el título '--- NUEVA CONFERENCIA ---'.
    `

    // Le pasamos el archivo previamente subido y nuestro prompt
    const result = await model.generateContent([
      {
        fileData: {
          mimeType: uploadResult.file.mimeType,
          fileUri: uploadResult.file.uri,
        },
      },
      { text: prompt },
    ])

    // Imprimimos la respuesta final
    console.log("✅ Transcripción Completada:")
    //console.log(result.response.text())

    const transcription = result.response.text()

    if (!transcription) {
      console.warn(
        "⚠️ La API no devolvió texto. Imprimiendo respuesta cruda para depurar:",
      )
      console.log(JSON.stringify(result, null, 2))
      return
    }

    const outputPath = rutaArchivo.replace(/\.mp3$/i, ".txt")
    fs.writeFileSync(outputPath, transcription, { encoding: "utf-8" })
    console.log(`✅ Transcripción completada: ${path.basename(outputPath)}`)

    // OPCIONAL: Eliminar el archivo de los servidores de Google para limpiar
    await fileManager.deleteFile(uploadResult.file.name)
  } catch (error) {
    console.error("❌ Error durante el proceso:", error)
  }
}

transcribirAudioLargo()
