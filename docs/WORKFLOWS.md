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

Ogni checkpoint conserva messaggi, risultati dei tool, riassunto, modello e modalità. I vecchi checkpoint restano disponibili anche dopo `/clear` e compattazione. `/clear` non cancella dati dal disco. `/new` crea una nuova sessione; `/sessions` elenca le sessioni; `/resume` apre il selettore e `/resume ID` cambia direttamente sessione quando l'agente è inattivo. `--no-session` disabilita anche i comandi che creerebbero o riprenderebbero una sessione.

Nel selettore `/resume`, la ricerca filtra senza distinzione tra maiuscole e minuscole il titolo, l'ID, il modello, la modalità e la data ISO salvata. Il titolo è un'anteprima del primo prompt recuperata dai checkpoint, anche se il contesto è stato compattato o svuotato. Le sessioni sono limitate allo stesso workspace e ordinate per ultimo aggiornamento. ↑/↓ navigano, Invio riprende, Esc/Ctrl+C chiudono. Durante la breve apertura del journal la selezione è disabilitata; un errore di apertura mantiene sia il menu sia la sessione precedente. Il comando non chiama NIM. `SessionInfo` include ora il campo opzionale `title`, disponibile anche negli elenchi CLI/RPC/SDK; nessuna migrazione dei journal è necessaria.

I file contengono conversazioni e porzioni di sorgente: possono includere dati sensibili. Non viene serializzata la configurazione del client, ma un segreto incluso dall'utente o letto da un tool può comparire nel journal. Conservare la directory in un account protetto. I permessi richiesti sono 0700/0600; su Windows vale anche l'ACL ereditata. Non c'è cifratura applicativa né cancellazione automatica.

Un lock impedisce scrittori simultanei. Un lock appartenente a un processo sicuramente terminato viene recuperato; un PID ancora attivo o un lock non valido richiede verifica manuale. All'apertura si scarta solo la coda priva del newline di commit. Messaggi con tool/result non abbinati vengono rifiutati. Prima di un effetto viene salvato “esito sconosciuto”; dopo un arresto non si ripetono automaticamente operazioni. Verificare i file prima di ritentare. I checkpoint non promettono durabilità contro perdita di alimentazione e non annullano effetti già completati. L'apertura di journal oltre 64 MiB viene rifiutata: conservare/esportare il file e iniziare una nuova sessione.

`/rename Nome della sessione` salva un nome esplicito, fino a 120 caratteri su una sola riga. Il menu `/resume` e `/sessions` lo mostrano al posto del titolo automatico; si può cercare sia il nome sia il primo prompt originale. Il nome è conservato nei checkpoint, resta dopo `/clear`, compattazione e ripresa, e non viene ereditato da `/new`. Una rinomina riuscita non cambia ID o messaggi e non chiama NIM. Con persistenza disabilitata o agente occupato il comando è rifiutato. Il campo opzionale `name` mantiene leggibili i vecchi journal.

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

Per `/tasks`, `/memory`, `/rewind`, regole granulari e relativi metodi RPC/SDK vedere la [guida avanzata](ADVANCED-WORKFLOWS.md).

La TUI supporta prompt multilinea: Invio invia, `Ctrl+J` o `\` seguito da Invio aggiungono una riga; Shift+Invio funziona se il terminale invia una sequenza distinta. L'incolla preserva righe e tabulazioni, con limite di 64.000 caratteri; un inserimento oltre il limite lascia intatta la bozza. Il cursore si muove anche tra le righe e il riquadro scorre senza occupare tutta la finestra.

`Ctrl+R` cerca nei prompt dello stesso workspace, inclusi i checkpoint anteriori a compattazione o `/clear` quando rientrano nella porzione di journal letta. La ricerca è locale, ignora i duplicati e presenta i più recenti prima. ↑/↓ e Ctrl+R scorrono; Invio/Tab caricano un prompt da modificare, senza inviarlo. Esc/Ctrl+C ripristinano la bozza senza cancellare il turno attivo. Si leggono al massimo le code di 100 journal recenti, 1 MiB per file e 16 MiB totali, restituendo fino a 200 prompt distinti. Non si scrivono file di cronologia aggiuntivi; la persistenza mantiene le regole della sessione. `--no-session` limita la ricerca alla memoria dell'invocazione. I comandi slash non fanno parte della cronologia dei prompt.

La TUI mantiene l'input attivo. Invio durante il lavoro accoda un follow-up FIFO, fino a 20; `/queue testo` fa lo stesso. Il dock mostra le anteprime; `/queue` elenca i messaggi con ID, `/queue edit ID testo` modifica un messaggio mantenendone ID e posizione, `/queue remove ID` ne rimuove uno e `/queue clear` svuota solo quelli in attesa lasciando continuare il turno corrente. Una modifica a un messaggio già partito viene rifiutata e non crea un nuovo prompt. `/steer testo` viene inserito dopo tutte le risposte del gruppo di tool corrente; non interrompe una scrittura o una risposta a metà. Esc/Ctrl+C cancella il turno e svuota i follow-up. Cambi di sessione/modello/modalità, compattazione e comandi plugin richiedono l'agente inattivo. All'uscita si attendono cancellazione, checkpoint e rilascio delle risorse. La coda è in memoria; dettagli su [permessi, undo, riferimenti e coda](HOST-WORKFLOWS.md).

```sh
kairos --json --prompt "Spiega l'architettura"
kairos --rpc --mode plan
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
| `queue`, `clearQueue` | nessuno; elenco con anteprime oppure rimozione dei soli messaggi in attesa |
| `removeQueued` | `id`: ID numerico del messaggio in attesa |
| `editQueued` | `id`, `text`: sostituisce un messaggio in attesa mantenendone posizione e richiesta originale |
| `context`, `undo` | nessuno; metadati dei riferimenti oppure ripristino dell'ultimo batch edit |
| `resume` | `id` sessione |
| `rename` | `name`: nome della sessione corrente |
| `branch` | `name`, `model`: opzionali; copia e attiva una nuova sessione, ritorna `sessionId` e `parentId` |
| `btw` | `text` obbligatorio, `model` opzionale; risposta laterale senza tool, anche durante `prompt` |
| `cancelSide`, `clearSide` | nessuno; annulla soltanto la domanda laterale oppure ne svuota la cronologia in memoria |
| `compact` | `strategy`: `model` o `local` opzionale |
| `mode` | `mode`: `plan` o `build` |
| `model` | `model`: ID NIM |
| `command` | `name`, `args` stringa opzionale |

`prompt` e `btw` rispondono al completamento; richieste successive di cancel/steer sono gestite mentre il turno è in corso. Gli eventi `side_start`, `side_token`, `side_wait`, `side_result` sono separati dagli eventi principali; `state.sideBusy` indica una domanda laterale attiva. `cancelSide` non interrompe `prompt`, mentre `cancel` annulla entrambi. EOF attende il lavoro già accettato, poi chiude. Limiti: 32 richieste pendenti, riga 128.000 caratteri, prompt 64.000. Gli errori di protocollo o comando vengono restituiti come oggetti `error`; i fallimenti del turno restano un `AgentResult` con status.

Gli eventi `queue` espongono ID e anteprime limitate a 200 caratteri, senza il testo completo dei prompt lunghi. `context` espone i metadati degli allegati e il budget. La CLI RPC usa gli stessi permessi della TUI: le operazioni `ask` falliscono esplicitamente senza interfaccia di approvazione. Scegliere `--permissions allow` solo per flussi autorizzati oppure integrare un callback SDK. `undo` non richiede inferenza ed è limitato agli edit registrati.

La coda si modifica anche direttamente da tastiera: ↑ dalla prima riga dell'input apre la selezione, ↑/↓ scelgono, Invio/Tab caricano il messaggio nell'editor. Invio salva ed Esc/Ctrl+C annulla, ripristinando la bozza precedente. Durante la modifica la coda si sospende; il turno corrente continua. La [guida alla coda](HOST-WORKFLOWS.md#coda-dei-messaggi) descrive precedenza dei tasti, ripresa e messaggi non più in attesa. L'SDK espone `queuePaused`, `pauseQueue()` e `resumeQueue()`; `cancel()` svuota e riattiva la coda, mentre `drain()` attende il lavoro attivo e non forza i messaggi sospesi.

## SDK

L'importazione del package non avvia la CLI e non richiede credenziali; la creazione del client reale richiede `NVIDIA_API_KEY`. La libreria non carica `.env` implicitamente.

```js
import 'dotenv/config';
import { createAgent, Interaction } from 'kairos';

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

`AgentLoop` espone anche `run`, `steer`, `setMode`, `compactContext`, `listSessions`, `resumeSession`, `renameSession(name)`, `branchSession({name?,model?})`, `sideQuestion(text,{model?,signal?})`, `clearSideQuestions()`, `newSession`, `command` e `close`; `sessionName` restituisce il nome scelto. RPC `state` include `sessionName`, mentre gli elenchi delle sessioni espongono `name` quando è stato impostato e `parentId` per le copie. `Interaction.sideQuestion(text,{model?})`, `sideBusy` e `cancelSide()` coordinano la domanda laterale; `drain()` e `close()` attendono anche quel lavoro. I client SDK personalizzati devono implementare `fork()` restituendo un client con emettitore di eventi indipendente; `NimClient.fork()` mantiene trasporto, impostazioni e limiter condiviso. Senza `fork()` una domanda laterale fallisce senza utilizzare il client principale. Per controlli diretti, attendere il turno e la domanda laterale prima di cambiare stato o chiudere. L'SDK esporta tipi di sessione, tool/plugin e protocollo. Le API di estensione sono locali a questo progetto: non promettono compatibilità binaria con plugin Pi/OpenCode.

`/branch [--model provider/modello] [Nome]` crea una copia persistente e passa alla copia, lasciando l'originale riprendibile. Copia messaggi, memoria, modalità ed effort compatibile, assegna un nuovo ID e salva `parentId`; non copia i file e non crea worktree Git. Richiede agente inattivo, nessuna domanda laterale attiva e persistenza abilitata. Un errore nella creazione mantiene attiva la sessione precedente.

`/btw [--model provider/modello] Domanda` risponde dal contesto già acquisito, senza tool, accesso aggiuntivo ai file o checkpoint nella conversazione principale. Un gruppo di tool in esecuzione è escluso dallo snapshot. Il modello opzionale riguarda soltanto la domanda laterale. La coda NIM resta unica: le richieste sono serializzate e rispettano 1.600 ms fra partenze. Il pannello usa ↑/↓ per scorrere, Esc per tornare al prompt lasciando proseguire il lavoro, Ctrl+C per annullare soltanto `/btw`, Invio/Spazio per chiudere una risposta completa e `x` per svuotare la cronologia laterale. `/btw` senza testo riapre l'ultimo risultato senza API. Sono mantenuti al massimo 20 scambi in memoria, tagliando le parti meno recenti per il budget di contesto senza modificare i messaggi principali. La cronologia laterale è azzerata da cambio di sessione, `/clear` o chiusura. I comandi su una sola riga supportano anche `--model=provider/modello` come prima opzione.
