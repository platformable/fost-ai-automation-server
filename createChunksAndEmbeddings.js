require("dotenv").config()
const { RecursiveCharacterTextSplitter } = require("@langchain/textsplitters")
const fs = require("node:fs")
const path = require("node:path")
const createEmbeddings = require("./createEmbeddings")
const extractMetadata = require("./extractMetadata")

async function procesarConferencia(filePath) {
  // -----------------------------
  // Metadata de la charla
  // -----------------------------

  console.log(`Procesando archivo: ${filePath}`)

  const transcript = fs.readFileSync(filePath, {
    encoding: "utf-8",
  })

  const metadataBase = await extractMetadata(transcript)

  console.log("Metadata extraída:", metadataBase)

  // -----------------------------
  // SOLO la transcripción
  // (sin Conference, Title, Speaker...)
  // -----------------------------
  // const transcript = fs.readFileSync("./french1/thors.txt", {
  //   encoding: "utf-8",
  // })

  // -----------------------------
  // Splitter
  // -----------------------------
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  })

  // Divide únicamente la transcripción
  const chunks = await splitter.createDocuments([transcript])

  // -----------------------------
  // Cabecera que añadiremos
  // a TODOS los chunks
  // -----------------------------
  const contexto = `
Conference: ${metadataBase.conference}

Talk: ${metadataBase.title}

Speaker: ${metadataBase.speaker}

Role: ${metadataBase.role}

Organization: ${metadataBase.organization}

Date: ${metadataBase.date}

Topics: ${metadataBase.topics.join(", ")}
`.trim()

  // -----------------------------
  // Construcción final
  // -----------------------------
  const documentos = chunks.map((chunk, index) => {
    return {
      id: `${metadataBase.conference_id}-${index + 1}`,

      pageContent: `
  ${contexto}

  Transcript:

  ${chunk.pageContent}
  `.trim(),

      metadata: {
        ...metadataBase,

        chunk_index: index + 1,

        total_chunks: chunks.length,

        chunk_id: `${metadataBase.conference_id}-${index + 1}`,
      },
    }
  })

  console.log(`Transcripción dividida en ${documentos.length} chunks.`)

  console.log("Transcripción dividida en chunks y lista para crear embeddings.")

  await createEmbeddings(documentos)
  console.log(
    "Embeddings creados y guardados en la base de datos.",
    metadataBase.conference_id,
  )
}

async function procesarTodosLosArchivos() {
  // Especifica la carpeta donde están los archivos .txt
  const carpeta = "./morgan3"

  try {
    // Lee todos los archivos de la carpeta
    const archivos = fs.readdirSync(carpeta)

    // Filtra solo los archivos .txt
    const archivosTxt = archivos.filter((archivo) => archivo.endsWith(".txt"))

    console.log(
      `Se encontraron ${archivosTxt.length} archivos .txt en ${carpeta}`,
    )

    // Procesa cada archivo secuencialmente
    for (const archivo of archivosTxt) {
      const rutaCompleta = path.join(carpeta, archivo)
      console.log(`\n${"=".repeat(60)}`)
      console.log(`Procesando: ${archivo}`)
      console.log("=".repeat(60))

      try {
        await procesarConferencia(rutaCompleta)
        console.log(`✓ Completado: ${archivo}`)
      } catch (error) {
        console.error(`✗ Error procesando ${archivo}:`, error.message)
      }
    }

    console.log(`\n${"=".repeat(60)}`)
    console.log("Procesamiento completo de todos los archivos")
    console.log("=".repeat(60))
  } catch (error) {
    console.error("Error al leer la carpeta:", error)
  }
}

procesarTodosLosArchivos()
