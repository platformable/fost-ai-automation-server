require("dotenv").config()
const { RecursiveCharacterTextSplitter } = require("@langchain/textsplitters")
const fs = require("node:fs")
const createEmbeddings = require("./createEmbeddings")
const extractMetadata = require("./extractMetadata")

async function procesarConferencia() {
  // -----------------------------
  // Metadata de la charla
  // -----------------------------

  const transcript = fs.readFileSync("./french2/siddharthc.txt", {
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

procesarConferencia()
