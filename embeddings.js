// embeddings.js
const { pipeline } = require("@xenova/transformers")

let embedder = null

export async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline(
      "feature-extraction",
      "Xenova/multilingual-e5-large",
    )
  }
  return embedder
}

// e5 requiere prefijos "query: " o "passage: " según el uso
export async function embedText(text, type = "passage") {
  const model = await getEmbedder()
  const prefixed = `${type}: ${text}`
  const output = await model(prefixed, { pooling: "mean", normalize: true })
  return Array.from(output.data)
}
