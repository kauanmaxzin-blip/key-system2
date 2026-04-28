// ╔══════════════════════════════════════════════════════════════╗
// ║   KAUAN XIT · KEY SERVER  v5.1  (Upstash Redis)             ║
// ║   Atualizado com suporte a Gerador Personalizado            ║
// ╚══════════════════════════════════════════════════════════════╝

const express = require("express");
const https   = require("https");
const fs      = require("fs");
const path    = require("path");

// CORS é importante para permitir que o gerador (frontend) faça requisições para este servidor
const cors    = require("cors"); 

const app     = express();

// Middlewares
app.use(express.json());
app.use(cors()); // Libera o acesso para o seu frontend fazer requisições POST

// Variáveis de Ambiente
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || "kauanxit_admin_2026";
const UPSTASH_URL     = process.env.UPSTASH_URL     || "";
const UPSTASH_TOKEN   = process.env.UPSTASH_TOKEN   || "";
const PORT            = process.env.PORT || 3000;

// ── UPSTASH: executar comando Redis via REST ──────────────────
function redis(command) {
    return new Promise((resolve) => {
        // Se as credenciais não estiverem configuradas, evita crash
        if (!UPSTASH_URL || !UPSTASH_TOKEN) {
            console.error("ERRO: UPSTASH_URL ou UPSTASH_TOKEN não configurados!");
            return resolve(null);
        }

        const body = JSON.stringify(command);
        const url  = new URL(UPSTASH_URL);
        const options = {
            hostname: url.hostname,
            path:     "/",
            method:   "POST",
            headers:  {
                "Authorization": "Bearer " + UPSTASH_TOKEN,
                "Content-Type":  "application/json",
                "Content-Length": Buffer.byteLength(body),
            }
        };
        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try { resolve(JSON.parse(data).result); }
                catch { resolve(null); }
            });
        });
        req.on("error", () => resolve(null));
        req.write(body);
        req.end();
    });
}

// Lê uma key do banco
async function getKey(key) {
    const val = await redis(["GET", "kx:" + key]);
    if (!val) return null;
    try { return JSON.parse(val); } catch { return null; }
}

// Salva uma key no banco
async function setKey(key, data) {
    await redis(["SET", "kx:" + key, JSON.stringify(data)]);
}

// Lista todas as keys
async function getAllKeys() {
    const keys = await redis(["KEYS", "kx:*"]);
    if (!keys || keys.length === 0) return {};
    const result = {};
    for (const k of keys) {
        const val = await redis(["GET", k]);
        try { result[k.replace("kx:", "")] = JSON.parse(val); } catch {}
    }
    return result;
}

// Deleta uma key
async function deleteKey(key) {
    await redis(["DEL", "kx:" + key]);
}

// ── GERADORES DE CÓDIGO ──────────────────────────────────────

// 1. Gerador Clássico (Formato: 7B4-8P9-8HP)
function gerarCodigoPadrao() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let cod = "";
    for (let s = 0; s < 3; s++) {
        if (s > 0) cod += "-";
        for (let c = 0; c < 3; c++)
            cod += chars[Math.floor(Math.random() * chars.length)];
    }
    return cod;
}

// 2. Gerador Dinâmico (Recebe as opções do Frontend)
function gerarCodigoPersonalizado(tamanho, maiusculas, minusculas, numeros, simbolos) {
    let charset = '';
    if (maiusculas) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (minusculas) charset += 'abcdefghijklmnopqrstuvwxyz';
    if (numeros) charset += '0123456789';
    if (simbolos) charset += '!@#$%^&*()_+~`|}{[]:;?><,./-=';

    // Fallback caso venha vazio por algum erro
    if (charset === '') charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    let result = '';
    for (let i = 0; i < tamanho; i++) {
        result += charset[Math.floor(Math.random() * charset.length)];
    }
    return result;
}

// ═══════════════════════════════════════════════════════════════
//  ROTAS
// ═══════════════════════════════════════════════════════════════

// ── [ADMIN] Gerar key
// Agora aceita parâmetros do Gerador Dinâmico
app.post("/generate", async (req, res) => {
    const { 
        password, 
        days = 7, 
        quantity = 1,
        
        // Parâmetros do novo gerador dinâmico
        useCustomGenerator = false,
        length = 16,
        uppercase = true,
        lowercase = true,
        numbers = true,
        symbols = false
    } = req.body;

    if (password !== ADMIN_PASSWORD)
        return res.json({ success: false, error: "Senha de admin incorreta!" });

    const qtd        = Math.min(Math.max(parseInt(quantity) || 1, 1), 100);
    const geradas    = [];
    const durationMs = (parseFloat(days) || 7) * 24 * 60 * 60 * 1000;

    for (let i = 0; i < qtd; i++) {
        let codigo, tentativas = 0;
        let existe;
        do {
            // Escolhe qual gerador usar com base na requisição
            if (useCustomGenerator) {
                codigo = gerarCodigoPersonalizado(length, uppercase, lowercase, numbers, symbols);
            } else {
                codigo = gerarCodigoPadrao();
            }

            existe = await getKey(codigo);
            tentativas++;
        } while (existe && tentativas < 50);

        await setKey(codigo, {
            createdAt:    Date.now(),
            durationMs,
            days:         parseFloat(days) || 7,
            activatedAt:  null,
            expiresAt:    null,
            lockedUserId: null,
        });
        geradas.push(codigo);
    }

    console.log(`[GENERATE] ${qtd} key(s) geradas.`);
    res.json({ success: true, keys: geradas });
});

// ── [SCRIPT] Validar key
// Body: { "key": "7B4-8P9-8HP", "userId": "123456789" }
app.post("/validate", async (req, res) => {
    // Ignora case e espaços para evitar erros bobos do usuário
    const key    = (req.body.key    || "").trim(); // Removemos o toUpperCase() para não quebrar as chaves personalizadas com letras minúsculas!
    const userId = String(req.body.userId || "").trim();

    if (!key)    return res.json({ valid: false, message: "Key nao enviada!" });
    if (!userId) return res.json({ valid: false, message: "UserId nao enviado!" });

    // Tenta buscar a key exata. Se não achar, tenta buscar com toUpperCase() para chaves antigas
    let entry = await getKey(key);
    if (!entry) {
        entry = await getKey(key.toUpperCase());
    }

    if (!entry)
        return res.json({ valid: false, message: "Key falsa ou nao gerada pelo servidor!" });

    const now = Date.now();

    // 1a vez: ativa, inicia timer e trava na conta
    if (!entry.activatedAt) {
        entry.activatedAt  = now;
        entry.expiresAt    = now + entry.durationMs;
        entry.lockedUserId = userId;
        // Salva com a chave original (mantém o case)
        await setKey(key, entry);
        console.log(`[ACTIVATE] Key ${key} por userId=${userId}. Expira em ${entry.days}d.`);
    }

    // Bloqueia outra conta
    if (entry.lockedUserId && entry.lockedUserId !== userId) {
        console.log(`[BLOCKED] Key ${key} pertence a ${entry.lockedUserId}, tentada por ${userId}`);
        return res.json({ valid: false, message: "Essa Key ja pertence a outra conta!" });
    }

    // Verifica expiracao
    if (!entry.expiresAt || now > entry.expiresAt)
        return res.json({ valid: false, message: "Key expirada!" });

    const remainingMs   = entry.expiresAt - now;
    const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
    const remainingHrs  = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    console.log(`[VALID] Key ${key} ok | userId=${userId} | Restam ${remainingDays}d ${remainingHrs}h`);

    res.json({
        valid: true,
        message: "Key valida! Bem-vindo(a).",
        expiresAt: entry.expiresAt,
        remainingDays,
        remainingHrs,
    });
});

// ── [ADMIN] Listar keys
app.post("/list", async (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD)
        return res.json({ success: false, error: "Senha incorreta!" });

    const db  = await getAllKeys();
    const now = Date.now();
    const lista = Object.entries(db).map(([codigo, e]) => ({
        key:      codigo,
        status:   !e.activatedAt ? "aguardando" : (now > e.expiresAt ? "expirada" : "ativa"),
        days:     e.days,
        userId:   e.lockedUserId || "-",
        expiresAt: e.expiresAt ? new Date(e.expiresAt).toLocaleString("pt-BR") : null,
    }));
    res.json({ success: true, total: lista.length, keys: lista });
});

// ── [ADMIN] Deletar key
app.post("/delete", async (req, res) => {
    const { password, key } = req.body;
    if (password !== ADMIN_PASSWORD)
        return res.json({ success: false, error: "Senha incorreta!" });

    const k = (key || "").trim();
    let entry = await getKey(k);
    if (!entry) {
        entry = await getKey(k.toUpperCase());
    }
    
    if (!entry) return res.json({ success: false, error: "Key nao encontrada!" });
    await deleteKey(k);
    res.json({ success: true, message: `Key ${k} deletada.` });
});

app.get("/", (req, res) => res.send("Kauan Xit Key Server v5.1 online! (Com Gerador Personalizado)"));

app.listen(PORT, () => {
    console.log(`\nKauan Xit Key Server v5.1 rodando na porta ${PORT}`);
    console.log(`Upstash URL: ${UPSTASH_URL}\n`);
});
