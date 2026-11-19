
import express from "express";
import { rateLimit } from "express-rate-limit";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ==========================================
// 1. CONFIGURATION
// ==========================================

const app = express();

const PORT = 3000;

const OLLAMA_URL = "http://127.0.0.1:11434";

const DEFAULT_MODEL =
  process.env.OLLAMA_MODEL || "gemma4:e4b";

// ==========================================
// 2. MIDDLEWARES
// ==========================================

// Lire les requêtes JSON
app.use(express.json({ limit: "1mb" }));

// Servir les fichiers HTML, CSS et JavaScript
app.use(express.static("public"));

// Limiter les requêtes HTTP vers notre API
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Trop de requêtes. Réessayez dans une minute."
  }
});

app.use("/api", apiLimiter);

// ==========================================
// 3. ROUTE POST /api/chat
// ==========================================

app.post("/api/chat", async (req, res) => {

  const {
    messages,
    model = DEFAULT_MODEL,
    stream = true,
    think,
    options
  } = req.body ?? {};

  // Vérifier que messages est un tableau non vide
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: "Le tableau messages est obligatoire et ne doit pas être vide."
    });
  }

  // Vérifier le type de stream
  if (typeof stream !== "boolean") {
    return res.status(400).json({
      error: "stream doit être un booléen."
    });
  }

  // Vérifier le modèle
  if (typeof model !== "string" || !model.trim()) {
    return res.status(400).json({
      error: "Le nom du modèle est invalide."
    });
  }

  // Vérifier le format des messages
  if (!messages.every(
    message =>
      message !== null &&
      typeof message === "object" &&
      ["system", "user", "assistant"].includes(message.role) &&
      typeof message.content === "string"
  )) {
    return res.status(400).json({
      error: "Format des messages invalide."
    });
  }

  // Vérifier le paramètre think
  if (think !== undefined && typeof think !== "boolean") {
    return res.status(400).json({
      error: "think doit être un booléen."
    });
  }

  // Valider la température si elle est fournie
  if (options !== undefined) {
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      typeof options.temperature !== "number" ||
      !Number.isFinite(options.temperature) ||
      options.temperature < 0 ||
      options.temperature > 2
    ) {
      return res.status(400).json({
        error: "La température doit être comprise entre 0 et 2."
      });
    }
  }

  // Contrôleur d'annulation
  const controller = new AbortController();

  // Annuler la génération si le client se déconnecte
  res.on("close", () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });

  try {

    // Construire la requête pour Ollama
    const body = {
      model,
      messages,
      stream
    };

    // Transmettre l'option de raisonnement
    if (think !== undefined) {
      body.think = think;
    }

    // Transmettre les options du modèle
    if (options !== undefined) {
      body.options = {
        temperature: options.temperature
      };
    }

    // Envoyer la requête à Ollama
    const response = await fetch(
      `${OLLAMA_URL}/api/chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    // Vérifier les erreurs d'Ollama
    if (!response.ok) {

      const details = await response.text();

      return res.status(502).json({
        error: `Erreur Ollama : ${details}`
      });
    }

    // ======================================
    // MODE SANS STREAMING
    // ======================================

    if (!stream) {

      const data = await response.json();

      return res.json(data);
    }

    // ======================================
    // MODE AVEC STREAMING
    // ======================================

    if (!response.body) {
      throw new Error("Ollama n'a pas retourné de flux.");
    }

    // Indiquer que la réponse est en NDJSON
    res.setHeader(
      "Content-Type",
      "application/x-ndjson"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache"
    );

    // Transmettre directement le flux Ollama
    await pipeline(
      Readable.fromWeb(response.body),
      res
    );

  } catch (error) {

    // Une annulation volontaire n'est pas une erreur
    if (controller.signal.aborted) {
      return;
    }

    console.error("Erreur Ollama :", error.message);

    // Les en-têtes ont déjà été envoyés
    if (res.headersSent) {
      return res.end();
    }

    return res.status(502).json({
      error: "Impossible de communiquer avec Ollama."
    });
  }
});

// ==========================================
// 4. ROUTE GET /api/models
// ==========================================

app.get("/api/models", async (req, res) => {

  try {

    // Récupérer les modèles installés
    const tagsResponse = await fetch(
      `${OLLAMA_URL}/api/tags`
    );

    if (!tagsResponse.ok) {
      throw new Error("Impossible de récupérer les modèles.");
    }

    const tags = await tagsResponse.json();

    // Récupérer les capacités de chaque modèle
    const models = await Promise.all(
      tags.models.map(async (model) => {

        const showResponse = await fetch(
          `${OLLAMA_URL}/api/show`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: model.name
            })
          }
        );

        if (!showResponse.ok) {
          throw new Error(
            `Impossible de lire les capacités de ${model.name}`
          );
        }

        const details = await showResponse.json();

        return {
          name: model.name,
          capabilities: details.capabilities ?? []
        };
      })
    );

    // Retourner les modèles au frontend
    return res.json(models);

  } catch (error) {

    console.error("Erreur modèles :", error.message);

    return res.status(502).json({
      error: "Impossible de récupérer les modèles Ollama."
    });
  }
});

// ==========================================
// 5. GESTION DES ERREURS JSON
// ==========================================

app.use((err, req, res, next) => {

  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({
      error: "JSON invalide."
    });
  }

  if (err.status === 413) {
    return res.status(413).json({
      error: "La requête dépasse la taille maximale autorisée."
    });
  }

  console.error("Erreur Express :", err);

  return res.status(500).json({
    error: "Erreur interne du serveur."
  });
});

// ==========================================
// 6. DÉMARRAGE DU SERVEUR
// ==========================================

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  console.log(`Serveur Ollama : ${OLLAMA_URL}`);
  console.log(`Modèle par défaut : ${DEFAULT_MODEL}`);
});
