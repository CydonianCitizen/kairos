# Sessioni, compattazione, plan mode, MCP ed estensioni

Queste funzionalità usano lo stesso AgentLoop nella TUI, nella CLI e nell'SDK. Tutte le richieste al modello, compresi i riassunti, passano dal client NVIDIA NIM e dal limiter condiviso di 1600 ms. I server MCP non ricevono la chiave NVIDIA per default.

## Avvio e sessioni

```sh
npm run build
npm start
node dist/cli.js --mode plan
node dist/cli.js --continue
node dist/cli.js --session ID
node dist/cli.js --list-sessions
node dist/cli.js --no-session --prompt "Spiega il progetto"
```

In PowerShell, se `npm start -- --mode plan` restituisce `EUNKNOWNCONFIG`, usare `node dist/cli.js --mode plan` oppure `npm.cmd start -- --mode plan`. Nel wrapper `npm.ps1` verificato, il separatore `--` viene consumato prima di arrivare a npm; `npm.cmd` lo inoltra correttamente. I comandi con `node dist/cli.js` funzionano direttamente dopo la build.

La CLI crea una sessione JSONL sotto `~/.nim-codex/sessions` (`C:\Users\NOME\.nim-codex\sessions` su Windows). `--session-dir` cambia la directory. `--continue` riprende la sessione più recente dello stesso workspace; `--session ID` ne seleziona una. Percorsi dei workspace sono canonicalizzati. Il modello e la modalità salvati vengono ripristinati; `--model` e `--mode` espliciti prevalgono all'avvio.

Ogni checkpoint conserva messaggi, risultati dei tool, riassunto, modello e modalità. I vecchi checkpoint restano disponibili anche dopo `/clear` e compattazione. `/clear` non cancella dati dal disco. `/new` crea una nuova sessione; `/sessions` elenca le sessioni; `/resume ID` cambia sessione quando l'agente è inattivo. `--no-session` disabilita anche i comandi che creerebbero o riprenderebbero una sessione.

I file contengono conversazioni e porzioni di sorgente: possono includere dati sensibili. Non viene serializzata la configurazione del client, ma un segreto incluso dall'utente o letto da un tool può comparire nel journal. Conservare la directory in un account protetto. I permessi richiesti sono 0700/0600; su Windows vale anche l'ACL ereditata. Non c'è cifratura applicativa né cancellazione automatica.

Un lock impedisce scrittori simultanei. Un lock appartenente a un processo sicuramente terminato viene recuperato; un PID ancora attivo o un lock non valido richiede verifica manuale. All'apertura si scarta solo la coda priva del newline di commit. Messaggi con tool/result non abbinati vengono rifiutati. Prima di un effetto viene salvato “esito sconosciuto”; dopo un arresto non si ripetono automaticamente operazioni. Verificare i file prima di ritentare. I checkpoint non promettono durabilità contro perdita di alimentazione e non annullano effetti già completati. L'apertura di journal oltre 64 MiB viene rifiutata: conservare/esportare il file e iniziare una nuova sessione.

## Compattazione e pianificazione

- `/compact`: riassunto NIM con sezioni obiettivo, decisioni, file, verifiche e lavoro restante. Usa una richiesta senza tool e lo stesso limiter; il riassunto interno non viene mostrato come risposta dell'agente.
- `/compact local`: estratti locali senza richieste API.
- `--compaction model|local`: strategia automatica quando il budget di contesto è superato. La CLI usa `model`; un errore del provider ripiega sugli estratti locali. L'SDK `AgentLoop` mantiene il default locale salvo configurazione esplicita.
- I riassunti sono limitati e possono perdere dettagli. Il budget rimane in caratteri, non in token. L'ultima richiesta viene conservata e le coppie tool/result non vengono spezzate. Una cancellazione non installa un riassunto parziale.
- `/plan`, `/build`, `/mode plan|build`: cambiano modalità a riposo. Plan espone solo letture, grafo e skill locali; il dispatcher rifiuta anche chiamate nascoste a shell, edit, plugin e MCP.

La modalità plan non è una sandbox OS. Il programma continua a scrivere i propri journal; plugin già caricati sono codice fidato con i privilegi del processo. Avviare direttamente in plan evita di caricare plugin e avviare server MCP. I callback dei plugin non vengono invocati in plan; non si può revocare a posteriori un processo o timer creato arbitrariamente da codice fidato.

## Contesto, skill e plugin

`--trust-workspace` autorizza il caricamento di `AGENTS.md`, `.nim/skills/*/SKILL.md` e `.nim/config.json`. Senza il flag non viene letto/eseguito quel contenuto. I percorsi locali non possono uscire dal workspace tramite traversal o symlink. Le istruzioni autorizzate restano subordinate al prompt di sistema. Non si installano automaticamente pacchetti dal repository.

Esempio `.nim/skills/review/SKILL.md`:

```markdown
---
name: review
description: Controlla le modifiche prima della consegna
---
Leggi i diff, verifica la correttezza e riporta test eseguiti e limiti.
```

`/skills` elenca le directory delle skill; `/skill review` seleziona la skill per il contesto dei turni successivi del processo corrente. Il modello può caricare skill pertinenti con `load_skills_batch`. La selezione manuale delle skill non viene ripristinata dalla sessione: selezionarla nuovamente dopo il riavvio. I documenti sono limitati a 64 KB e il contesto iniettato è ridotto; non mettere interi manuali in AGENTS.md.

Configurazione `.nim/config.json` (omettere i server non utilizzati):

```json
{
  "plugins": [".nim/plugins/example.mjs"],
  "mcpServers": {
    "local": {
      "command": "node",
      "args": [".nim/mcp-server.mjs"],
      "env": {"SERVICE_TOKEN": "MY_SERVICE_TOKEN"}
    },
    "remote": {
      "url": "https://example.org/mcp",
      "headers": {"Authorization": "MY_MCP_AUTHORIZATION"}
    }
  }
}
```

I valori di `env` e `headers` sono **nomi di variabili d'ambiente**, non i segreti stessi. Per esempio `MY_MCP_AUTHORIZATION` contiene il valore completo `Bearer ...` nel proprio ambiente o `.env` escluso da Git. Argomenti di processo e URL non devono contenere credenziali. Redirect HTTP disabilitati per non inoltrare autenticazione a destinazioni inattese.

Plugin locale ESM, `.nim/plugins/example.mjs`:

```js
export default function setup(api) {
  api.registerTool({
    name: 'double',
    description: 'Raddoppia un valore numerico',
    parameters: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
      additionalProperties: false,
    },
    async execute({ value }, { signal }) {
      signal?.throwIfAborted();
      return { value: value * 2 };
    },
  });
  api.registerCommand('greet', async args => `Ciao ${args}`);
  api.onTurnEnd(async result => {
    // Solo build; usare stderr per diagnostica, mai stdout.
    console.error(`Turno terminato: ${result.status}`);
  });
  return async () => {
    // Liberare eventuali risorse possedute dal plugin.
  };
}
```

`/greet Nome` invoca il comando; `/extensions` elenca i comandi registrati. `registerTool` valida lo schema JSON con Ajv; i tool arrivano al modello tramite `inspect_extension_tools` e `extension_tools_batch`, senza moltiplicare gli schemi nel prompt. I nomi sono univoci; non si possono sostituire comandi nativi. I batch validano tutti gli argomenti prima del primo effetto e restituiscono risultati per elemento. I plugin devono rispettare AbortSignal e chiudere le proprie risorse. Non c'è isolamento da plugin malevoli o un marketplace.

## MCP

Il client usa il [TypeScript SDK ufficiale](https://github.com/modelcontextprotocol/typescript-sdk), pacchetto client v2, con negoziazione compatibile gestita dall'SDK. Supporta stdio e Streamable HTTP, discovery dei tool e risorse, timeout, cancellazione e chiusura delle connessioni. Non abilita sampling: un server non può chiedere ulteriori chiamate NIM fuori dal ciclo agente. Non implementa login OAuth interattivo, elicitation, sottoscrizioni o prompt MCP.

I tool esterni sono qualificati `server:tool`; il catalogo è iniettato nel contesto, gli schemi si ottengono con `inspect_extension_tools`, le chiamate con `extension_tools_batch`. `mcp_resources_batch` elenca risorse quando `uri` è assente e legge una URI quando è presente. `/mcp` mostra i server connessi. Connessioni e plugin vengono caricati al primo avvio/turno build; in plan sono bloccati anche quando il server dichiara un tool read-only. Timeout: connessione/discovery 15 s, chiamate 30 s. Limiti: 10 server, 100 tool per server, 200 tool complessivi, 20 operazioni per batch.

## Interazione, JSON e RPC

La TUI mantiene l'input attivo. Invio durante il lavoro accoda un follow-up FIFO, fino a 20; `/queue testo` fa lo stesso. `/steer testo` viene inserito dopo tutte le risposte del gruppo di tool corrente; non interrompe una scrittura o una risposta a metà. Esc/Ctrl+C cancella il turno e svuota i follow-up. Cambi di sessione/modello/modalità, compattazione e comandi plugin richiedono l'agente inattivo. All'uscita si attendono cancellazione, checkpoint e rilascio delle risorse.

```sh
nim-codex --json --prompt "Spiega l'architettura"
nim-codex --rpc --mode plan
```

`--json` emette JSONL con `{ "type", "data" }` per gli eventi e `{ "type": "result", "sessionId", "result" }` alla fine. Il testo del modello è nel risultato e negli eventi token. Nessuna TUI in questi modi. Diagnostica su stderr. I plugin devono evitare scritture dirette su stdout.

RPC usa una richiesta JSON-RPC 2.0 per riga, con `id` stringa/numero, `method`, `params` oggetto. Le risposte possono arrivare fuori ordine; il client le correla con `id`. Gli eventi sono notifiche `method: "event"`, `params: {type, data}`. Non è un server HTTP e non apre porte.

```json
{"jsonrpc":"2.0","id":1,"method":"state"}
{"jsonrpc":"2.0","id":2,"method":"prompt","params":{"text":"Prepara un piano"}}
{"jsonrpc":"2.0","id":3,"method":"steer","params":{"text":"Considera Windows"}}
{"jsonrpc":"2.0","id":4,"method":"cancel"}
```

| Metodo | Parametri |
| --- | --- |
| `prompt`, `steer` | `text` |
| `cancel`, `state`, `sessions`, `newSession`, `clear`, `commands` | nessuno |
| `resume` | `id` sessione |
| `compact` | `strategy`: `model` o `local` opzionale |
| `mode` | `mode`: `plan` o `build` |
| `model` | `model`: ID NIM |
| `command` | `name`, `args` stringa opzionale |

`prompt` risponde al completamento; richieste successive di cancel/steer sono gestite mentre il turno è in corso. EOF attende il lavoro già accettato, poi chiude. Limiti: 32 richieste pendenti, riga 128.000 caratteri, prompt 64.000. Gli errori di protocollo o comando vengono restituiti come oggetti `error`; i fallimenti del turno restano un `AgentResult` con status.

## SDK

L'importazione del package non avvia la CLI e non richiede credenziali; la creazione del client reale richiede `NVIDIA_API_KEY`. La libreria non carica `.env` implicitamente.

```js
import 'dotenv/config';
import { createAgent, Interaction } from 'nim-codex';

const agent = await createAgent({
  workspace: process.cwd(),
  session: {}, // default directory; omettere per memoria, false vieta persistenza
  mode: 'plan',
  compaction: 'model',
  trustWorkspace: false,
});
const interaction = new Interaction(agent);
agent.on('onTokenStream', token => process.stderr.write(token));
try {
  const result = await interaction.prompt('Prepara un piano di modifica');
  console.log(result.status, result.text, agent.sessionId);
} finally {
  await interaction.close();
}
```

`AgentLoop` espone anche `run`, `steer`, `setMode`, `compactContext`, `listSessions`, `resumeSession`, `newSession`, `command` e `close`. Per controlli diretti, attendere il turno prima di cambiare stato o chiudere; Interaction coordina coda e cancellazione. L'SDK esporta tipi di sessione, tool/plugin e protocollo. Le API di estensione sono locali a questo progetto: non promettono compatibilità binaria con plugin Pi/OpenCode.
