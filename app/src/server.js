import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const app = express();
const PORT = 4000;
const OLLAMA_URL = "http://localhost:11434";
const CHATS_DIR = "./src/chats";
const DEFAULT_MODEL = "gemma2:9b";
const SYSTEM_PROMPT = `Voláš sa Trubis. Si osobný asistent mužského rodu.

JAZYK — KRITICKÁ PODMIENKA:
Komunikuješ VÝLUČNE po slovensky. Nikdy nepoužívaj češtinu. Slovenčina a čeština sú rozdielne jazyky — nenahrádzaj slovenské slová českými ekvivalentmi.
Príklady zakázaných českých slov a ich slovenské náhrady:
- "potřebuješ" → "potrebuješ"
- "přepínám" → "prepínam"
- "uživatel" → "používateľ"
- "hodnocení" → "hodnotenie"
- "omlouvám" → "ospravedlňujem"
- "zjistit" → "zistiť"
- "cíle" → "ciele"
- "metody" → "metódy"
Tykaj používateľovi. Používaj správnu slovenskú gramatiku.

ŠTÝL:
Odpovedaj stručne a vecne. Neomoluvaj sa zbytočne. Ak je vstup nejasný, opýtaj sa jednou vetou.

SPRÁVANIE:
Buď proaktívny — keď dostaneš tému, navrhni konkrétne kroky alebo oblasti, ktoré treba riešiť. Neklaď len otázky, ale aj sám ponúkaj smery, nápady alebo štruktúru. Ak používateľ povie že chce niečo vylepšiť, navrhni kde začať a prečo. Drž sa témy konverzácie.`;

app.use(cors());
app.use(express.json());
app.use(express.static("src"));

// Zaisti existenciu chats/ adresára
await fs.mkdir(CHATS_DIR, { recursive: true });

// ─── Pomocné funkcie ───────────────────────────────────────────────────────────

async function loadChat(chatId) {
  const file = path.join(CHATS_DIR, `${chatId}.json`);
  try {
    const data = await fs.readFile(file, "utf8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveChat(chat) {
  const file = path.join(CHATS_DIR, `${chat.id}.json`);
  await fs.writeFile(file, JSON.stringify(chat, null, 2), "utf8");
}

async function listChats() {
  const files = await fs.readdir(CHATS_DIR);
  const chats = [];
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(CHATS_DIR, f), "utf8"));
      chats.push({ id: data.id, title: data.title, updatedAt: data.updatedAt });
    } catch {}
  }
  return chats.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// ─── API Routes ────────────────────────────────────────────────────────────────

// Zoznam dostupných modelov z Ollamy
app.get("/api/models", async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await r.json();
    res.json(data.models?.map((m) => m.name) ?? []);
  } catch (err) {
    res.status(500).json({ error: "Ollama nedostupná: " + err.message });
  }
});

// Zoznam chatov
app.get("/api/chats", async (req, res) => {
  res.json(await listChats());
});

// Načítaj konkrétny chat
app.get("/api/chats/:id", async (req, res) => {
  const chat = await loadChat(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat nenájdený" });
  res.json(chat);
});

// Nový chat
app.post("/api/chats", async (req, res) => {
  const chat = {
    id: uuidv4(),
    title: req.body.title || "Nový chat",
    model: req.body.model || DEFAULT_MODEL,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveChat(chat);
  res.json(chat);
});

// Premenuj chat
app.patch("/api/chats/:id", async (req, res) => {
  const chat = await loadChat(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat nenájdený" });
  if (req.body.title) chat.title = req.body.title;
  if (req.body.model) chat.model = req.body.model;
  chat.updatedAt = new Date().toISOString();
  await saveChat(chat);
  res.json(chat);
});

// Vymaž chat
app.delete("/api/chats/:id", async (req, res) => {
  const file = path.join(CHATS_DIR, `${req.params.id}.json`);
  try {
    await fs.unlink(file);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "Chat nenájdený" });
  }
});

// ─── Hlavná chat route — streaming ────────────────────────────────────────────

app.post("/api/chats/:id/message", async (req, res) => {
  const { content, model } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Prázdna správa" });

  const chat = await loadChat(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat nenájdený" });

  const usedModel = model || chat.model || DEFAULT_MODEL;

  // Pridaj správu používateľa
  chat.messages.push({ role: "user", content, timestamp: new Date().toISOString() });

  // Streaming odpoveď
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let assistantContent = "";

  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: usedModel,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...chat.messages.map(({ role, content }) => ({ role, content })),
        ],
        stream: true,
      }),
    });

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          const token = json.message?.content || "";
          if (token) {
            assistantContent += token;
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          }
          if (json.done) {
            // Ulož celú konverzáciu
            chat.messages.push({
              role: "assistant",
              content: assistantContent,
              model: usedModel,
              timestamp: new Date().toISOString(),
            });
            chat.updatedAt = new Date().toISOString();
            // Auto-titulok z prvej správy
            if (chat.messages.length === 2 && chat.title === "Nový chat") {
              chat.title = content.slice(0, 50) + (content.length > 50 ? "…" : "");
            }
            await saveChat(chat);
            res.write(`data: ${JSON.stringify({ done: true, chatId: chat.id })}\n\n`);
          }
        } catch {}
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }

  res.end();
});

// ─── Štart ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🟢 Trubis beží na http://localhost:${PORT}`);
  console.log(`   Ollama: ${OLLAMA_URL}`);
  console.log(`   Model:  ${DEFAULT_MODEL}\n`);
});
