# KAIROS (κ)

**Right-Time Coding Agent · NVIDIA NIM**

TUI inline con logo κ oro/bronzo, palette condivisa e banner fisso in alto con versione, modello e statistiche reali del Code Graph. Modello in verde NVIDIA, effort oro, grafo e cooldown restano aggiornati nella barra di stato unica sotto l'input. Nei terminali sotto le 80 colonne il banner usa un layout compatto; sotto le 16 righe si riduce al titolo.

**Kairon**, la mascotte ufficiale, passeggia sopra l'input con ciuffo oro, corpo bronzo e occhi ciano. Cammina più velocemente mentre l'agente lavora, si ferma durante il cooldown NIM e mostra occhi rossi durante i retry 429 o dopo un errore. Il fumetto riporta attività e countdown reali, senza richieste API aggiuntive. Si adatta alla larghezza del terminale e lascia spazio all'input quando l'altezza non basta o sono aperti i selettori modello/effort.

Fasi 1–4: client NVIDIA NIM, tool filesystem batch, motore Code Graph locale, ciclo agente e TUI inline con CLI.

Fase 5: [audit e semplificazioni](docs/PHASE-5-AUDIT.md), con [confronto Pi/OpenCode e proposte successive](docs/PI-OPENCODE-COMPARISON.md).

Sono implementati anche **sessioni persistenti, compattazione semantica, plan mode, MCP, skill/plugin, input accodabili e JSON/RPC/SDK**. La [guida alle nuove funzionalità](docs/WORKFLOWS.md) contiene comandi, configurazione ed esempi completi.

Sono disponibili anche **approvazioni con anteprima, undo persistente degli edit, riferimenti espliciti a file/simboli e coda visibile dei messaggi**. KAIROS ricorda l'ultimo modello scelto per le nuove sessioni, anche cambiando repository. Dettagli e comandi nella [guida ai flussi host](docs/HOST-WORKFLOWS.md).

La [ricerca su Claude Code](docs/CLAUDE-CODE-RESEARCH.md) raccoglie i meccanismi verificati nel codice pubblico, i comportamenti documentati e gli spunti applicabili a KAIROS.

## Installazione e verifica

Richiede Node.js 20.19+ oppure 22.12+ (incluso Node 24) e npm. Per `run_bash` serve Bash; su Windows viene cercato Git Bash. Per installazioni non standard impostare `BASH_PATH`.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Per usare NIM da qualsiasi repository, creare una sola volta il file personale `~/.kairos/.env` (su Windows `%USERPROFILE%\.kairos\.env`) con:

```dotenv
NVIDIA_API_KEY=la_tua_chiave
```

La CLI cerca la chiave in questo ordine: **variabile d'ambiente → `.env` del workspace selezionato → `~/.kairos/.env`**. Il file personale evita di copiare la chiave in ogni progetto; per una chiave specifica del progetto, copiare `.env.example` in `.env` e valorizzarla. `.env` è escluso da Git. I test usano risposte HTTP simulate e non richiedono credenziali.

Modello, effort e timeout iniziali si configurano in `~/.kairos/config.json`; le istruzioni personali si scrivono in `~/.kairos/system-prompt.md`, senza ricompilare. La [guida alla configurazione](docs/CONFIGURATION.md) descrive precedenze, impostazioni del progetto e il comando esplicito `kairos --check-models` per verificare gli endpoint reali. Sono disponibili anche gli [esiti della verifica hosted](docs/NIM-VERIFICATION.md).

### Comando `kairos`

Dalla radice del repository, dopo la build, installare il comando per lo sviluppo:

```sh
npm link
```

Poi, da qualsiasi directory di progetto:

```sh
kairos
kairos --mode plan
kairos --version
```

Su Windows, usare `npm.cmd link` se PowerShell intercetta gli argomenti di npm. La directory dei comandi globali npm deve essere nel `PATH` del terminale; `npm prefix -g` mostra il prefisso (su macOS/Linux i comandi sono nella sottodirectory `bin`).

Per distribuire una copia installabile invece di un collegamento al checkout:

```sh
npm pack
npm install --global ./kairos-0.0.1-alpha.tgz
```

`npm pack` esegue automaticamente la build e include i moduli compilati, la documentazione e il modello `.env.example`. Dopo l'installazione il comando è sempre `kairos`; il pacchetto richiede Node.js. La chiave NVIDIA viene letta dall'ambiente, dal `.env` del workspace o dal file personale `~/.kairos/.env`, in quest'ordine. Questa procedura installa il pacchetto locale, senza pubblicarlo sul registro npm.

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

`complete()` restituisce `NimResult<ChatCompletion>`. `stream()` restituisce tutti i chunk, inclusi i delta delle chiamate tool, ed emette `onTokenStream` per testo e rifiuti del modello. Entrambi accettano un `AbortSignal` come secondo argomento. Gli errori HTTP e l'esaurimento dei retry producono `{ ok: false, error, status }`; una chiave mancante produce un errore di configurazione nel costruttore. La libreria non carica automaticamente `.env`: lo fa esplicitamente il chiamante, come nell'esempio. La CLI carica il `.env` del workspace selezionato e usa `~/.kairos/.env` per le variabili ancora mancanti, conservando quelle già presenti nell'ambiente.

Tutte le istanze condividono una coda FIFO nello stesso processo, con una sola richiesta attiva e almeno 1600 ms tra gli avvii. Processi Kairos sullo stesso computer coordinano la stessa chiave tramite file locali in `~/.kairos/rate-limits`, senza salvare la chiave in quei file. Lo slot resta occupato durante lo streaming e il backoff. I 429 consentono tre retry dopo 5, 10 e 20 secondi, rispettando anche `Retry-After` se maggiore. Uno stream già iniziato non viene ripetuto. Altre applicazioni, computer o directory di coordinamento diverse non condividono questo limite; l'ordine tra processi dipende dalla contesa del lock, mentre la FIFO resta garantita nel singolo processo.

I retry automatici dell'SDK sono disabilitati con `maxRetries: 0`, come previsto dalla [documentazione OpenAI SDK](https://github.com/openai/openai-node/blob/main/docs/configuration.md), per evitare richieste fuori dal limiter.

Il [catalogo dei modelli](docs/MODELS.md) si aggiorna all'avvio della TUI con un controllo NVIDIA ogni **24 ore**, usando cache locale e fallback offline. I profili inclusi, verificati sulle pagine NVIDIA il **31 ottobre 2026**, usano **Mistral Large 4** come predefinito e comprendono DeepSeek V4.1 Flash, MiniMax M3.1 Flash, GLM 5.3 Flash e Nemotron 3.5 Bolt. Gli altri modelli scaricati sono candidati, senza supporto ai tool certificato dall'endpoint. `/model` apre un selettore navigabile con frecce e Invio, con il modello attivo evidenziato ed Esc per annullare; `/model provider/model` e `--model` accettano anche ID esterni alla selezione. Le sessioni riprese conservano il modello precedente, salvo selezione esplicita. `parallel_tool_calls` viene inviato solo con tool e supporto documentato (Nemotron Bolt), oppure tramite override nel costruttore del client.

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

Il dispatcher valida gli argomenti e la CLI chiede approvazione prima di edit, shell e chiamate esterne. Le regole `allow/ask/deny` e `--permissions` controllano gli effetti; in modalità non interattiva `ask` si ferma con un errore esplicito. Le protezioni dei percorsi presuppongono un workspace locale fidato, senza modifiche concorrenti ostili dei symlink. I tool eseguono comunque con i privilegi del processo: non sono una sandbox OS.

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

Il prompt in `src/core/system-prompt.ts` guida l'uso del grafo, dei tool batch e delle verifiche. Viene inviato a NIM come messaggio con ruolo `system` a ogni iterazione. Per aggiungere istruzioni senza ricompilare, usare `~/.kairos/system-prompt.md`, `systemPromptFile` nella configurazione oppure `--system-prompt FILE`. Per personalizzare un singolo progetto, scrivere le istruzioni in `AGENTS.md` e avviare `kairos --trust-workspace`: sono istruzioni aggiuntive subordinate al prompt di sistema. Il prompt base resta modificabile nel sorgente con una successiva build. Contenuti del repository, risultati dei tool e frammenti di cronologia sono trattati come dati. `--trust-workspace` autorizza anche skill, configurazione delle estensioni e preferenze `.kairos/config.json` del progetto.

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

Configurare `NVIDIA_API_KEY` nel file personale `~/.kairos/.env`, nell'ambiente oppure nel `.env` del workspace. Per un progetto diverso:

```sh
node dist/cli.js --cwd /percorso/progetto --model mistralai/mistral-large-4-1t-a52b
```

`node dist/cli.js --help` e `node dist/cli.js --version` non richiedono credenziali. Il campo `bin` espone `kairos` dopo un eventuale `npm link` locale, mantenendo `nim-codex` come alias. Le sessioni restano in `~/.nim-codex/sessions` e la configurazione del workspace in `.nim/`, per continuare a usare i dati esistenti. Senza TTY usare `node dist/cli.js --prompt "Spiega NimClient"`: esegue un turno con output testuale, senza Ink. `--max-iterations` e `--max-context-chars` configurano i limiti del ciclo. Il flag `--scope <none|read-only|workspace|full>` vincola le autorizzazioni: `none` blocca ogni operazione filesystem/shell, `read-only` consente la sola lettura nel workspace, `workspace` (predefinito) consente lettura e scrittura confinate al progetto, `full` autorizza l'accesso completo al dispositivo.

La TUI usa React 18, Ink 5 e `ink-text-input`. I turni completati, i log dei tool e i diff vengono stampati con `<Static>`, conservando lo scrollback nativo. L'area visibile mantiene il banner in alto e una finestra sugli ultimi messaggi sopra il prompt, ancorato in basso con separatori orizzontali e prefisso `❯`. L'ultima riga raccoglie modello in verde NVIDIA, effort oro, stato NIM/attività, modalità, `AST file/simboli !avvisi`, coda `Q` e ID breve della sessione. Nei terminali stretti i dettagli finali vengono abbreviati o nascosti per preservare modello ed effort. Kairon resta sopra l'input quando c'è spazio. Il dock si adatta ad altezza, larghezza e menu aperti senza attivare l'alternate screen buffer.

| Comando | Comportamento |
| --- | --- |
| `/model` | Apre il selettore: frecce ↑/↓, Invio per confermare, Esc per annullare |
| `/effort [livello]` | Apre il selettore effort o imposta direttamente un livello supportato |
| `/model provider/model` | Cambia modello conservando la conversazione |
| `/graph [directory]` | Ricostruisce il grafo e stampa la mappa locale |
| `/context` | Mostra riferimenti espliciti, righe e budget usato |
| `/undo` | Anteprima e ripristino dell'ultimo batch edit registrato |
| `/rewind [ID ambito]` | Selettore dei prompt e ripristino di conversazione, file o entrambi |
| `/tasks [start/logs/stop]` | Gestisce comandi shell supervisionati in background |
| `/memory [add/update/remove/clear]` | Gestisce note durevoli del progetto |
| `/clear` | Azzera il contesto della conversazione, conservando lo scrollback |
| `/compact` | Riassume la cronologia tramite NIM con fallback locale |
| `/compact local` | Compatta senza chiamate al modello |
| `/plan`, `/build` | Passa tra pianificazione e modifica |
| `/resume [ID]` | Apre il selettore delle sessioni oppure riprende direttamente un ID |
| `/rename NOME` | Rinomina la sessione corrente e salva il nome |
| `/branch [--model ID] [NOME]` | Copia la conversazione e passa alla nuova sessione |
| `/btw [--model ID] DOMANDA` | Risposta separata dal contesto corrente, anche durante il lavoro; senza domanda riapre l'ultima |
| `/sessions`, `/new` | Elenca le sessioni o ne crea una nuova |
| `/skills`, `/skill NAME`, `/extensions`, `/mcp` | Ispeziona e usa le estensioni |
| `/steer TEXT`, `/queue TEXT` | Guida il turno attivo o accoda un follow-up |
| `/thinking [on\|off]` | Mostra o nasconde lo streaming CoT (Chain of Thought / reasoning) |
| `/scope [livello]` | Imposta l'ambito di accesso ai file (`none`, `read-only`, `workspace`, `full`) |
| `/queue`, `/queue remove ID`, `/queue clear` | Elenca o rimuove messaggi in attesa senza fermare il turno corrente |
| `/queue edit ID TESTO` | Modifica un messaggio ancora in coda mantenendone ID e posizione |
| `/help` | Mostra comandi e scorciatoie |
| `/exit` | Esce quando nessun turno è attivo |

Digitando `/` si apre un menu scorrevole con tutti i comandi e una breve descrizione, inclusi quelli dei plugin caricati. La lista si filtra continuando a scrivere; ↑/↓ spostano la selezione e Invio esegue il comando scelto. Per i comandi con argomenti obbligatori, come `/mode` e `/steer`, Invio prepara l'input da completare. `Tab` completa senza eseguire. `Esc` o `Ctrl+C` chiudono il menu e riportano al prompt.

Per modificare un messaggio in coda senza riscriverlo: **↑ dalla prima riga dell'input → ↑/↓ per scegliere → Invio/Tab per aprire**. Il testo esistente si modifica direttamente nell'input; **Invio salva**, **Esc annulla e ripristina la bozza**. La coda resta sospesa durante la modifica, mentre il turno già attivo continua.

`/resume` apre un **menu ricercabile delle sessioni del progetto**, ordinate dalla più recente. Ogni voce mostra il nome scelto o un titolo ricavato localmente dal primo prompt, data, modello, modalità e ID breve; la sessione corrente è indicata e la selezione iniziale privilegia un'altra sessione. Scrivere filtra nome, titolo originale, ID completo, modello, modalità e data; ↑/↓ spostano la selezione e Invio riprende la sessione. Esc/Ctrl+C tornano al prompt. Se una sessione è già in uso o non può essere aperta, il menu mostra l'errore e mantiene la sessione corrente. `/resume ID` continua a funzionare; `--no-session` disabilita la ripresa. I titoli automatici restano disponibili dopo `/clear` e compattazione perché vengono letti dai checkpoint originali, senza usare NIM.

`/rename Piano del grafo` salva il nome della sessione corrente, che compare nel menu `/resume` e in `/sessions`. Il nome può contenere spazi e Unicode, deve essere di 1–120 caratteri su una sola riga e non può contenere caratteri di controllo. Rinomina e ricerca non chiamano NIM. Il nome sopravvive a riavvio, ripresa, `/clear` e compattazione; `/new` crea una sessione senza ereditare il nome. La rinomina richiede una sessione persistente e l'agente inattivo. I journal precedenti senza nome rimangono leggibili.

`/branch Strategia alternativa` crea un nuovo ID e una copia persistente di messaggi, riassunto, modalità e impostazioni correnti, poi passa alla copia. L'originale resta disponibile con `/resume`; il messaggio di conferma ne mostra l'ID. `/branch --model minimaxai/minimax-m3.1-flash Strategia alternativa` sceglie un modello per la copia senza cambiare quello dell'originale. L'effort viene mantenuto se supportato, altrimenti torna su `auto`. La ramificazione richiede persistenza e agente inattivo, non chiama NIM e condivide gli stessi file del progetto: non crea un branch Git o una worktree.

`/btw --model z-ai/glm-5.3-flash Perché abbiamo scelto questo parser?` avvia una domanda laterale in un pannello separato, usando una copia del contesto disponibile e un client indipendente. Non ha tool, non modifica file o sessione principale e non salva la risposta nel journal. Il lavoro principale continua; tutte le chiamate NIM condividono la stessa coda a 37,5 RPM. Omettere `--model` usa il modello corrente, senza modificarne la selezione. L'opzione deve precedere domanda o nome; è accettata anche la forma `--model=provider/modello`.

Nel pannello `/btw`, ↑/↓ scorrono la risposta, Esc torna al prompt lasciando proseguire il lavoro e Ctrl+C annulla soltanto la domanda laterale. A risposta conclusa, Invio/Spazio chiudono e `x` cancella la cronologia laterale. `/btw` senza testo riapre l'ultimo pannello senza chiamare NIM. Sono conservati in memoria al massimo 20 scambi laterali, entro il budget di contesto; `/clear`, cambio di sessione o chiusura li azzerano. È attiva al massimo una domanda laterale alla volta.

L'input è **multilinea**: Invio invia il prompt completo; `Ctrl+J`, `\` seguito da Invio e le sequenze Shift+Invio riconosciute aggiungono una nuova riga. Se il terminale non distingue Shift+Invio da Invio, usare una delle prime due alternative. Frecce, Home/End, Ctrl+A/Ctrl+E, Backspace e Canc modificano il testo senza spezzare emoji o caratteri combinati. I blocchi incollati mantengono righe e tabulazioni; un blocco multilinea che inizia con `/` viene trattato come prompt. L'editor scorre intorno al cursore, fino a sei righe visibili, lasciando il footer in basso.

`Ctrl+R` apre la **ricerca nei prompt del progetto**, compresi quelli salvati in sessioni precedenti. Scrivere filtra senza distinzione tra maiuscole e minuscole; ↑/↓ o un altro Ctrl+R scorrono i risultati. Invio/Tab caricano il risultato nella bozza: un secondo Invio lo invia. Esc/Ctrl+C chiudono la ricerca ripristinando la bozza senza interrompere il lavoro. La ricerca riusa i journal esistenti e non crea nuovi file; con `--no-session` usa solo i prompt in memoria. Per mantenere la ricerca limitata, restituisce fino a 200 prompt distinti, leggendo la coda di massimo 100 journal recenti (1 MiB per file, 16 MiB totali); prompt molto vecchi possono quindi non comparire. Nessuna richiesta NIM per scrittura o ricerca.

Nel selettore `/model` puoi scrivere per filtrare i nomi senza distinzione tra maiuscole e minuscole, usare Backspace per correggere e poi confermare con Invio. `/effort` mostra solo i livelli configurati per il modello attivo: inizialmente Mistral Large 4 (`auto`, `none`, `high`) e MiniMax M3.1 Flash (`auto`, `low`, `medium`, `high`, `xhigh`, `max`). Gli altri modelli usano `auto`, senza aggiungere parametri non verificati. La scelta compare nella barra di stato e viene salvata nella sessione; cambiando modello ritorna ad `auto` se il nuovo modello non supporta il livello scelto. Vedi [effort e parametri](docs/MODELS.md#reasoning-effort).

La maggior parte dei comandi slash è locale; `/compact` usa NIM e i comandi plugin possono eseguire operazioni esterne. Durante un turno l'input resta disponibile per follow-up e `/steer`. Quando non è aperto un menu, `Esc` cancella il lavoro attivo e svuota la coda; `Ctrl+C` fa lo stesso oppure esce quando l'agente è inattivo.

Digitare `@` seguito dall'inizio di un file o simbolo per ottenere suggerimenti dall'indice. `↑` e `↓` selezionano un suggerimento, `Tab` completa il riferimento finale nell'input. Il completamento è disponibile anche per i comandi slash. Quando non ci sono completamenti attivi, `Tab` espande o richiude i dettagli dell'ultimo tool; durante il lavoro può farlo direttamente. I dettagli nel dock sono un'anteprima limitata, mentre log e diff applicati restano nella cronologia.

`@src/file.ts`, `@NomeSimbolo`, `@file:percorso` e `@symbol:NomeSimbolo` allegano davvero sorgenti e righe al turno, entro un budget di massimo 12.000 caratteri. `/context` ne mostra il consumo. Fonti mancanti, ambigue o non sicure vengono segnalate prima dell'inferenza; dettagli e limiti nella [guida ai flussi host](docs/HOST-WORKFLOWS.md).

I diff unificati sono calcolati dal contenuto effettivo prima e dopo ogni scrittura riuscita: aggiunte verdi, eliminazioni rosse e intestazioni degli hunk ciano. Le modifiche fallite non producono diff. I comandi shell producono un log di esito, ma non un diff automatico delle modifiche esterne. Le sequenze di controllo terminale provenienti da sorgenti e output del modello vengono eliminate prima della visualizzazione.

`AgentLoop.initialize()`, `setModel()`, `compact()` e `graphSnapshot` permettono alla UI di gestire indice, modello e contesto senza ricreare la sessione. Il pacing NIM viene verificato al momento dell'invio HTTP effettivo, così la preparazione variabile delle richieste nell'SDK non accorcia l'intervallo di 1600 ms.

La verifica include rendering Ink, completamento con tastiera, comandi slash, countdown, diff, test del ciclo agente e uno smoke test della CLI in un terminale Windows. Le risposte NIM nei test sono simulate.

### Stato delle dipendenze UI

La Fase 5 ha rimosso `@inkjs/ui`, usato soltanto per lo spinner, insieme a quattro dipendenze transitive. La barra mostra l'attività tramite i componenti Ink già presenti. Alla verifica del 31 ottobre 2026, `npm audit` riporta zero vulnerabilità note.
