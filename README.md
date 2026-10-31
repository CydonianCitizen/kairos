# nim-codex

Fasi 1–4: client NVIDIA NIM, tool filesystem batch, motore Code Graph locale, ciclo agente e TUI inline con CLI.

Fase 5: [audit e semplificazioni](docs/PHASE-5-AUDIT.md), con [confronto Pi/OpenCode e proposte successive](docs/PI-OPENCODE-COMPARISON.md).

Sono implementati anche **sessioni persistenti, compattazione semantica, plan mode, MCP, skill/plugin, input accodabili e JSON/RPC/SDK**. La [guida alle nuove funzionalità](docs/WORKFLOWS.md) contiene comandi, configurazione ed esempi completi.

## Installazione e verifica

Richiede Node.js 20.19+ oppure 22.12+ (incluso Node 24) e npm. Per `run_bash` serve Bash; su Windows viene cercato Git Bash. Per installazioni non standard impostare `BASH_PATH`.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Per usare NIM, copiare `.env.example` in `.env` e valorizzare `NVIDIA_API_KEY`, oppure impostare la variabile nell'ambiente. `.env` è escluso da Git. I test usano risposte HTTP simulate e non richiedono credenziali.

## Client

Dopo la build, esempio da un modulo JavaScript nella radice del progetto:

```js
import 'dotenv/config';
import { NimClient } from './dist/core/nim-client.js';
import { FS_TOOL_SCHEMAS } from './dist/tools/fs-tools.js';

const client = new NimClient();
client.on('onRateLimitWait', ({ remainingMs, reason }) => {
  console.log(reason, remainingMs);
});
const result = await client.complete({
  messages: [{ role: 'user', content: 'Descrivi i file che ti servono per esplorare il progetto.' }],
  tools: FS_TOOL_SCHEMAS,
});
if (result.ok) console.log(result.value.choices);
else console.error(result.error);
```

`complete()` restituisce `NimResult<ChatCompletion>`. `stream()` restituisce tutti i chunk, inclusi i delta delle chiamate tool, ed emette `onTokenStream` per testo e rifiuti del modello. Entrambi accettano un `AbortSignal` come secondo argomento. Gli errori HTTP e l'esaurimento dei retry producono `{ ok: false, error, status }`; una chiave mancante produce un errore di configurazione nel costruttore. La libreria non carica automaticamente `.env`: lo fa esplicitamente il chiamante, come nell'esempio. La CLI carica soltanto il `.env` del workspace selezionato.

Tutte le istanze condividono una coda FIFO nello stesso processo, con una sola richiesta attiva e almeno 1600 ms tra gli avvii. Lo slot resta occupato durante lo streaming e il backoff. I 429 consentono tre retry dopo 5, 10 e 20 secondi, rispettando anche `Retry-After` se maggiore. Uno stream già iniziato non viene ripetuto. Processi distinti o altre applicazioni che usano la stessa chiave non condividono questo limite.

I retry automatici dell'SDK sono disabilitati con `maxRetries: 0`, come previsto dalla [documentazione OpenAI SDK](https://github.com/openai/openai-node/blob/main/docs/configuration.md), per evitare richieste fuori dal limiter.

Il [catalogo dei modelli](docs/MODELS.md), aggiornato dalle pagine ufficiali NVIDIA il **31 ottobre 2026**, usa **Mistral Large 4** come predefinito e include DeepSeek V4.1 Flash, MiniMax M3.1 Flash, GLM 5.3 Flash e Nemotron 3.5 Bolt. `/model` mostra gli ID disponibili; `/model provider/model` e `--model` accettano anche ID esterni alla selezione. Le sessioni riprese conservano il modello precedente, salvo selezione esplicita. La disponibilità è verificata sul catalogo pubblico, senza chiamate reali con la tua API key. `parallel_tool_calls` viene inviato solo con tool e supporto documentato (Nemotron Bolt), oppure tramite override nel costruttore del client.

## Tool batch

```js
import { FsTools } from './dist/tools/fs-tools.js';

const tools = new FsTools(process.cwd());
const files = await tools.read_files_batch(['package.json', 'tsconfig.json']);
const edits = await tools.apply_edits_batch([
  { path: 'example.txt', old_text: '', new_text: 'Nuovo file\n' },
]);
const command = await tools.run_bash('git status --short');
```

- Batch da 1 a 100 elementi, risultati indipendenti per ogni elemento.
- Percorsi relativi al workspace; traversal e symlink verso l'esterno rifiutati. Letture limitate a file regolari di massimo 1 MiB.
- Sostituzioni esatte e univoche, in ordine. `old_text: ''` crea esclusivamente un nuovo file; la directory deve esistere. Le modifiche batch sono serializzate per istanza e non hanno rollback globale.
- Le scritture vengono preparate in un file temporaneo adiacente e pubblicate tramite rename; i nuovi file usano un hard link esclusivo, senza sovrascrivere un file apparso nel frattempo. Gli errori di scrittura prima della pubblicazione conservano l'originale. Il filesystem deve supportare gli hard link per la creazione; non sono garantiti rollback globale o durabilità a un'interruzione di alimentazione.
- `AgentLoop` emette `onToolStart` e `onToolEnd`; i tool diretti restituiscono soltanto i risultati.
- `run_bash` parte nel workspace, usa un timeout predefinito di 30 secondi (configurabile da 1 ms a 300 s), termina l'albero dei processi al timeout e limita ciascuno di stdout/stderr a 15.000 caratteri. Il risultato include exit code, timeout e troncamento. Esegue comandi arbitrari: non è una sandbox.

Il dispatcher valida gli argomenti e il ciclo agente esegue i tool richiesti dal modello con i permessi del processo corrente. Non è presente un'interfaccia di approvazione interattiva. Le protezioni dei percorsi presuppongono un workspace locale fidato, senza modifiche concorrenti ostili dei symlink.

## Code Graph locale (Fase 2)

```js
import { indexWorkspace } from './dist/graph/indexer.js';
import { GraphTools, GRAPH_TOOL_SCHEMAS } from './dist/tools/graph-tools.js';

const graph = await indexWorkspace(process.cwd(), {
  onProgress: ({ files, symbols }) => console.log({ files, symbols }),
});
const tools = new GraphTools(graph);
console.log(graph.stats);
console.log(graph.diagnostics);
console.log(tools.get_repo_map('src'));
console.log(tools.inspect_symbol_graph(['NimClient', 'NimClient.complete']));
console.log(graph.search('rate limit client', 10));
```

L'indicizzazione non usa il client NIM e non richiede una chiave API. I parser `web-tree-sitter` e le grammatiche WASM sono caricati dalle dipendenze locali; non servono compilatori nativi. Sono supportati TS/TSX, JS/JSX, Python, Rust e Go, incluse le estensioni ESM/CJS.

Il grafo diretto Graphology contiene file, simboli e archi `contains`, `imports`, `calls`. Conserva sorgente esatto del nodo AST, firma, nome qualificato e righe a base 1. I tool espongono schemi JSON in `GRAPH_TOOL_SCHEMAS`, collegati al dispatcher della Fase 3. Gli eventi di esecuzione sono emessi dal ciclo agente.

`inspect_symbol_graph(symbol_names)` accetta da 1 a 100 nomi. Per i duplicati restituisce tutti i risultati; si può restringere con `percorso:Nome.qualificato`. Le chiamate includono i possibili destinatari locali; `targets: []` indica che la chiamata non è risolta. `dependents` indica i file che importano direttamente il file del simbolo, non una prova che usino specificamente quel simbolo.

`get_repo_map(directory?)` restituisce una mappa di massimo 12.000 caratteri, con indicazione del troncamento. Il filtro directory è relativo al workspace. `graph.search(query, limit)` restituisce posizioni ordinate per corrispondenza dei termini ed è usato per l'iniezione automatica del contesto nel ciclo agente.

La risoluzione copre import relativi JS/TS (inclusa la convenzione NodeNext `.js` → `.ts`), import Python locali, percorsi Rust semplici `crate`/`self`/`super`, e package Go interni al modulo dichiarato in `go.mod`. Non è un type checker: alias `tsconfig`, re-export concatenati, import dinamici, CommonJS `require`, Rust `use` raggruppati/glob e dispatch dinamico restano non risolti. I possibili destinatari locali non equivalgono a un call graph certificato dal compilatore.

Sono rispettati `.gitignore` alla radice e nelle sottocartelle, incluse le negazioni consentite da Git. Sono esclusi symlink, `.git`, `node_modules`, build, ambienti virtuali e cache comuni. Il limite per file è 1 MiB, configurabile con `maxFileBytes`. Errori di lettura, file troppo grandi e sintassi incompleta sono riportati in `diagnostics`; gli errori di caricamento delle grammatiche interrompono invece l'indicizzazione.

Ogni esecuzione produce uno snapshot nuovo e indipendente. Dopo modifiche ai file, richiamare `indexWorkspace` e sostituire il grafo/tools precedenti: non è presente un watcher. I parser e gli alberi AST sono liberati dopo l'uso; `AbortSignal` permette di interrompere tra i file. I test coprono tutti i linguaggi con parser reali, import, alias, Unicode, ignore annidati, cancellazione, symlink e reindicizzazione.

## Ciclo agente (Fase 3)

Con `NVIDIA_API_KEY` configurata e dopo `npm run build`, salvare questo esempio come modulo `.mjs` nella radice del progetto:

```js
import { AgentLoop } from './dist/core/agent-loop.js';

const agent = new AgentLoop({
  workspace: process.cwd(),
  model: 'mistralai/mistral-large-4-1t-a52b',
  maxIterations: 12,
  maxContextChars: 64000,
});
agent.on('onTokenStream', token => process.stdout.write(token));
agent.on('onToolStart', ({ id, name }) => console.log('\nTool:', id, name));
agent.on('onToolEnd', ({ name, result }) => console.log('\nResult:', name, result.ok));
agent.on('onGraphUpdate', stats => console.log('\nGraph:', stats));
agent.on('onRateLimitWait', ({ reason, remainingMs }) => console.log('\nWait:', reason, remainingMs));
agent.on('onCompaction', ({ removedMessages }) => console.log('\nCompacted:', removedMessages));

const controller = new AbortController();
// Chiamare controller.abort() per interrompere il turno.
const result = await agent.run('Spiega il funzionamento di NimClient', {
  signal: controller.signal,
});
console.log('\n', result.status, result.error ?? '');
```

Il prompt in `src/core/system-prompt.ts` guida l'uso del grafo, dei tool batch e delle verifiche. Contenuti del repository, risultati dei tool e frammenti di cronologia sono trattati come dati. `--trust-workspace` autorizza separatamente istruzioni da `AGENTS.md`, skill e configurazione locale delle estensioni.

`AgentLoop.run()` indicizza il workspace prima del turno, cerca i simboli rilevanti per il prompt e aggiunge firme, percorsi e righe alle richieste NIM. La mappa viene rigenerata per ogni richiesta senza accumularne copie nella cronologia. Dopo un batch di modifiche riuscito, anche solo parzialmente, o dopo un comando shell, il grafo viene ricostruito prima del tool successivo. Discovery e compattazione locale non richiedono API; la compattazione semantica usa il client NIM e lo stesso limiter.

Lo streaming usa esclusivamente `NimClient`, quindi tutte le iterazioni rispettano il limiter e i retry esistenti. Gli argomenti delle tool call vengono ricomposti per indice dai chunk SSE. Stream incompleti, troncati o con ID duplicati vengono rifiutati prima di eseguire tool. Il dispatcher valida JSON, nomi, tipi, limiti batch e campi aggiuntivi; gli errori dei singoli tool sono restituiti al modello con il relativo `tool_call_id`.

Le chiamate multiple sono eseguite in ordine, preservando dipendenze come modifica → ispezione. `onToolStart` espone ID, nome e argomenti JSON; `onToolEnd` espone ID, nome e risultato completo, incluso `mutated`. I risultati inviati al modello sono limitati a 12.000 caratteri (o un terzo del budget configurato, se inferiore), con un involucro JSON valido che segnala il troncamento.

La stessa istanza conserva la conversazione tra più `run()`. `agent.messages` restituisce una copia della cronologia e `agent.clear()` la azzera quando nessun turno è attivo. I turni concorrenti sulla stessa istanza restituiscono `busy`. Ogni istanza deve possedere il proprio client NIM per evitare che eventi di sessioni indipendenti vengano mescolati; il limiter NIM resta condiviso nel processo.

La compattazione conserva il prompt corrente e gruppi completi di messaggi/tool. La strategia locale mantiene fino a 2.400 caratteri di estratti; quella semantica genera un riassunto NIM e ripiega sul metodo locale in caso di errore. La CLI usa la strategia semantica per default, configurabile con `--compaction local`. Il budget di 64.000 caratteri si applica a messaggi e schemi tool: non è un conteggio esatto dei token. Se il prompt corrente non entra nel budget, il ciclo restituisce `context_limit`.

Il risultato contiene `status`, `text`, `iterations` ed eventualmente `error`. Gli stati sono `completed`, `cancelled`, `iteration_limit`, `context_limit`, `error` e `busy`. Il limite predefinito è 12 iterazioni logiche (i retry HTTP del client non contano come nuove iterazioni). Gli errori NIM, compresi i 429 dopo l'esaurimento dei retry, fermano il turno senza un'eccezione non gestita.

La cancellazione interrompe richieste NIM, indicizzazione tra file e processi shell; impedisce l'avvio dei tool/modifiche successivi. Le operazioni già completate non vengono annullate. Anche in caso di cancellazione la cronologia mantiene una risposta per ogni tool call, marcando quelle non eseguite. Il turno successivo ricostruisce l'indice prima di ripartire. Una scrittura filesystem già in corso può completarsi prima che la cancellazione venga osservata.

I test della Fase 3 coprono il percorso SDK SSE → tool → SDK, pacing reale, ricostruzione degli argomenti frammentati, aggiornamento del grafo, errori di validazione, limiti, compattazione e cancellazione. Il trasporto HTTP è simulato: nessuna chiamata a NVIDIA è effettuata dalla suite.

## TUI inline e CLI (Fase 4)

```sh
npm ci
npm run build
npm start
```

Impostare `NVIDIA_API_KEY` nell'ambiente oppure nel file `.env` del workspace. Per un progetto diverso:

```sh
node dist/cli.js --cwd /percorso/progetto --model mistralai/mistral-large-4-1t-a52b
```

`node dist/cli.js --help` e `node dist/cli.js --version` non richiedono credenziali. Il campo `bin` espone `nim-codex` dopo un eventuale `npm link` locale. Senza TTY usare `node dist/cli.js --prompt "Spiega NimClient"`: esegue un turno con output testuale, senza Ink. `--max-iterations` e `--max-context-chars` configurano i limiti del ciclo.

La TUI usa React 18, Ink 5 e `ink-text-input`. I turni completati, i log dei tool e i diff vengono stampati con `<Static>`. Non viene attivato l'alternate screen buffer. Solo il dock inferiore viene aggiornato: anteprima dello stream, ultimo tool, stato del grafo, modello, countdown NIM e input con bordo arrotondato. Il dock si adatta alle dimensioni del terminale.

| Comando | Comportamento |
| --- | --- |
| `/model` | Elenca il modello attivo e il catalogo |
| `/model provider/model` | Cambia modello conservando la conversazione |
| `/graph [directory]` | Ricostruisce il grafo e stampa la mappa locale |
| `/clear` | Azzera il contesto della conversazione, conservando lo scrollback |
| `/compact` | Riassume la cronologia tramite NIM con fallback locale |
| `/compact local` | Compatta senza chiamate al modello |
| `/plan`, `/build` | Passa tra pianificazione e modifica |
| `/sessions`, `/resume ID`, `/new` | Gestisce sessioni persistenti |
| `/skills`, `/skill NAME`, `/extensions`, `/mcp` | Ispeziona e usa le estensioni |
| `/steer TEXT`, `/queue TEXT` | Guida il turno attivo o accoda un follow-up |
| `/help` | Mostra comandi e scorciatoie |
| `/exit` | Esce quando nessun turno è attivo |

La maggior parte dei comandi slash è locale; `/compact` usa NIM e i comandi plugin possono eseguire operazioni esterne. Durante un turno l'input resta disponibile per follow-up e `/steer`. `Esc` cancella il lavoro attivo e svuota la coda; `Ctrl+C` fa lo stesso oppure esce quando l'agente è inattivo.

Digitare `@` seguito dall'inizio di un file o simbolo per ottenere suggerimenti dall'indice. `↑` e `↓` selezionano un suggerimento, `Tab` completa il riferimento finale nell'input. Il completamento è disponibile anche per i comandi slash. Quando non ci sono completamenti attivi, `Tab` espande o richiude i dettagli dell'ultimo tool; durante il lavoro può farlo direttamente. I dettagli nel dock sono un'anteprima limitata, mentre log e diff applicati restano nella cronologia.

I diff unificati sono calcolati dal contenuto effettivo prima e dopo ogni scrittura riuscita: aggiunte verdi, eliminazioni rosse e intestazioni degli hunk ciano. Le modifiche fallite non producono diff. I comandi shell producono un log di esito, ma non un diff automatico delle modifiche esterne. Le sequenze di controllo terminale provenienti da sorgenti e output del modello vengono eliminate prima della visualizzazione.

`AgentLoop.initialize()`, `setModel()`, `compact()` e `graphSnapshot` permettono alla UI di gestire indice, modello e contesto senza ricreare la sessione. Il pacing NIM viene verificato al momento dell'invio HTTP effettivo, così la preparazione variabile delle richieste nell'SDK non accorcia l'intervallo di 1600 ms.

La verifica include rendering Ink, completamento con tastiera, comandi slash, countdown, diff, test del ciclo agente e uno smoke test della CLI in un terminale Windows. Le risposte NIM nei test sono simulate.

### Stato delle dipendenze UI

La Fase 5 ha rimosso `@inkjs/ui`, usato soltanto per lo spinner, insieme a quattro dipendenze transitive. La barra mostra l'attività tramite i componenti Ink già presenti. Alla verifica del 31 ottobre 2026, `npm audit` riporta zero vulnerabilità note.
