const OpenAI = require("openai")
const fs = require("node:fs")

const transcript = fs.readFileSync("./french1.txt", {
  encoding: "utf-8",
})

const client = new OpenAI({
  baseURL: "http://localhost:1234/v1",
  apiKey: "lm-studio",
})

const main = async () => {
  const completion = await client.chat.completions.create({
    model: "qwen2.5-3b-instruct",
    messages: [
      {
        role: "system",
        content: `You are an expert editor of conference transcripts.

Rules:

1. Remove ALL microphone tests.
2. Remove ALL conversations before the presentation starts.
3. Remove ALL casual conversations between speakers.
4. Remove filler words:
   - um
   - uh
   - hmm
   - you know
   - like
5. Remove duplicated words caused by speech:
   Example:
   "the the the the project"
   becomes
   "the project"

6. Remove timestamps like:
   [00:01:32]

7. Improve punctuation.

8. If speakers introduce themselves during the presentation, replace "Speaker 1" with their real name.

9. Keep ONLY presentation content.

10. Return ONLY the cleaned transcript.

Do not explain.
Do not summarize.
`,
      },
      {
        role: "user",
        content: transcript,
      },
    ],
    temperature: 0.1,
  })

  //  console.log(completion.choices[0].message.content)

  const transcription = completion.choices[0].message.content
  fs.writeFileSync("./french1_clean.txt", transcription, {
    encoding: "utf-8",
  })
  console.log("Transcripción completada:")
}

main()
