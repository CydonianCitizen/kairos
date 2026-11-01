# Permessi, undo, riferimenti e coda

La [guida avanzata](ADVANCED-WORKFLOWS.md) aggiunge regole granulari, isolamento opzionale, processi in background, memoria tra sessioni e rewind per prompt.

## Approvazioni

La CLI usa `ask` per modifiche ai file, shell e chiamate esterne. La TUI mostra il diff delle modifiche oppure comando/argomenti prima dell'effetto: `y` autorizza quella richiesta, `n` la rifiuta, Esc/Ctrl+C annulla il lavoro. Invio non approva. Le anteprime lunghe scorrono con frecce e PageUp/PageDown; Ctrl+A/Ctrl+E vanno a inizio/fine. Un file cambiato dopo l'anteprima invalida l'operazione.

Per automazioni che devono eseguire effetti senza interazione:

```sh
kairos --permissions allow --prompt "Aggiorna i test"
kairos --permissions deny --prompt "Esamina il progetto"
```

`allow`, `ask` e `deny` si possono scegliere per categoria in `~/.kairos/config.json`, oppure nel progetto autorizzato con `--trust-workspace`:

```json
{
  "permissions": { "edits": "ask", "shell": "deny", "external": "ask" }
}
```

Le categorie si uniscono singolarmente; il flag CLI le sostituisce tutte. In modalità non interattiva, `ask` restituisce `approval_required` senza eseguire l'operazione né attendere una tastiera. Il turno si ferma senza un'altra richiesta NIM. Plan continua a bloccare tutti gli effetti, anche con `allow`.

I permessi valgono per i tool esposti e i comandi plugin, non costituiscono una sandbox OS. Import e callback di plugin autorizzati con `--trust-workspace` sono codice fidato. Per compatibilità, l'SDK mantiene `allow` quando non riceve regole: passare `permissions` e un callback `approve(request, signal)` per integrare un'interfaccia propria. La decisione deve essere esplicitamente `true`.

## Undo dei file

`/undo` prepara e approva il ripristino dell'ultimo batch `apply_edits_batch` dello stesso workspace, anche dopo il riavvio. Non chiama NIM e non usa Git. I contenuti originali, inclusi byte non UTF-8 e modalità del file, sono conservati in `~/.kairos/undo`, separati per percorso canonico del workspace. Un file creato dall'agente viene rimosso solo con questo comando esplicito.

Prima del ripristino vengono controllati tutti i contenuti, le modalità e i percorsi. Modifiche successive dell'utente o percorsi sostituiti da symlink fanno rifiutare il batch. Le modifiche ripetute allo stesso file tornano allo stato precedente al batch. In caso di errore si tenta il ripristino dello stato iniziale dell'undo senza sovrascrivere ulteriori modifiche concorrenti. Un intento persistente permette di riprendere un undo interrotto quando i file corrispondono esattamente agli stati originali o modificati registrati.

Sono annullabili solo gli edit registrati: shell, plugin e MCP possono avere effetti che non entrano nel journal. Non c'è una transazione globale fra più editor/processi; il controllo immediatamente precedente alla pubblicazione riduce le corse, senza eliminare la finestra di concorrenza del filesystem. I journal contengono sorgenti, usano permessi richiesti 0700/0600 (su Windows anche le ACL ereditate) e non vengono cifrati o eliminati automaticamente. Serve un filesystem locale con hard link.

L'SDK abilita il journal passando `undoDirectory`; `agent.undoLast(signal)` applica la stessa policy degli edit. RPC espone `undo`, che richiede un agente inattivo e un permesso utilizzabile senza TUI.

## Riferimenti espliciti

I riferimenti allegano contenuti al turno, oltre al completamento con Tab:

```text
Spiega @src/math.ts e @sum
Controlla @file:src/math.ts e @symbol:sum
Controlla @symbol:src/math.ts:sum
Leggi @file:"docs/my notes.md"
```

Il grafo risolve i simboli a percorsi e righe. Un simbolo ambiguo richiede il percorso esplicito. Le email non diventano riferimenti. File assenti, percorsi esterni/traversal, symlink non sicuri e file di credenziali vengono rifiutati prima dell'inferenza. I file devono essere regolari e non superare 1 MiB. `@file:` consente anche file ordinari ignorati dal grafo, se selezionati intenzionalmente.

Il budget totale dei riferimenti è il minore fra 12.000 caratteri e un quarto del budget di contesto. Include intestazioni e avvisi di troncamento; i riferimenti duplicati vengono deduplicati. `/context` mostra fonti, righe, troncamenti e budget; la barra di stato ne mostra il consumo. RPC espone `context` e l'evento omonimo con metadati, senza ricopiare i sorgenti negli eventi.

Gli allegati sono snapshot all'inizio del turno: possono precedere edit successivi del tool. Il turno seguente sostituisce gli allegati precedenti; i riferimenti di `/steer` si aggiungono entro lo stesso limite. Il contenuto viene etichettato come dato non fidato. Il [benchmark del grafo](GRAPH-BENCHMARK.md) registra le misure: l'indicizzazione resta completa, locale e senza API, senza una cache incrementale aggiunta in questa versione.

## Coda dei messaggi

Durante il lavoro, scrivere un altro prompt e premere Invio lo mette in coda. I messaggi partono uno alla volta, in ordine FIFO, dopo la conclusione del turno precedente. Il dock mostra il numero e le prime due anteprime quando c'è spazio; la barra di stato conserva il contatore anche nei pannelli. Ci sono al massimo 20 messaggi in attesa, ciascuno di massimo 64.000 caratteri.

Per modificare senza riscrivere il messaggio: premere **↑ dalla prima riga dell'input**, scegliere con **↑/↓**, poi **Invio o Tab** per aprire il testo esistente nell'input. Il primo ↑ seleziona il messaggio più vicino all'input, cioè l'ultimo della coda; gli altri ↑ risalgono verso il primo. L'anteprima segue la selezione e la bozza precedente resta conservata. Dall'ultimo elemento, ↓ torna alla bozza. Completamenti e ricerca della cronologia mantengono le proprie frecce.

Durante la modifica, **Invio salva**, **Esc o Ctrl+C annulla** e ripristina la bozza precedente. Restano disponibili cursore, multilinea, incolla, completamento dei riferimenti e ricerca Ctrl+R. La coda si sospende fino al salvataggio o annullamento; il turno già attivo continua. Tutti i messaggi mantengono ID e ordine. La bozza in modifica sopravvive anche a una richiesta di approvazione che sostituisce temporaneamente l'input. Nei terminali bassi, banner e anteprime si riducono per lasciare visibili tasti e barra di stato.

La selezione da sola non sospende la coda: se il messaggio parte o viene rimosso prima di aprirlo, Invio segnala che non è più in attesa e conserva la bozza, senza inviarla. Se un messaggio viene rimosso durante la modifica, il testo resta nell'editor con un errore; Esc permette di tornare alla bozza precedente.

| Comando | Effetto |
| --- | --- |
| `/queue` oppure `/queue list` | Elenco completo dei messaggi in attesa e relativi ID |
| `/queue TESTO` | Accoda un prompt, anche multilinea o con testo che inizia per `/` |
| `/queue edit ID TESTO` | Sostituisce il testo di un messaggio in attesa, conservando ID e posizione |
| `/queue remove ID` | Rimuove solo quel messaggio in attesa |
| `/queue clear` | Svuota la coda; il turno corrente continua |
| `/steer TESTO` | Inserisce una guida nel turno corrente al prossimo confine fra gruppi di tool |

Per modificare un messaggio, trovare l'ID con `/queue` e inviare, per esempio, `/queue edit 2 Controlla anche i test Windows`. La sostituzione aggiorna subito l'anteprima e può contenere più righe o testo che inizia con `/`, senza eseguirlo come comando. Un testo vuoto o oltre 64.000 caratteri viene rifiutato lasciando intatto il messaggio. Si può modificare anche una coda piena. Se il messaggio è già partito, è stato rimosso o cancellato, la modifica viene rifiutata senza creare un nuovo prompt; il turno corrente prosegue normalmente.

Esc/Ctrl+C sul prompt principale, fuori da selezione/modifica, ricerca o menu, annulla il lavoro e svuota la coda. Chiudere un menu o pannello conserva invece il comportamento specifico del pannello. Un'approvazione pendente mantiene sospeso il turno corrente e i follow-up aspettano. La coda vive in memoria e non viene ripristinata dopo il riavvio. Rimuovere un messaggio restituisce `status: cancelled` al chiamante che ne attendeva il risultato; non viene inviato a NIM né aggiunto alla conversazione.

RPC accetta più richieste `prompt` senza attendere la precedente e le completa in ordine di esecuzione. `queue` restituisce ID, anteprima fino a 200 caratteri, lunghezza e indicatore di troncamento; `editQueued` richiede `id` e `text` e restituisce `{updated:true}` oppure `{updated:false}` quando il messaggio non è più in attesa. `removeQueued` richiede `id`, `clearQueue` non richiede parametri. L'evento `queue` contiene lo stesso elenco limitato e viene emesso anche dopo una modifica. L'SDK espone `Interaction.queueSnapshot` (copie di `{id,text}`), `editQueued(id,text)`, `removeQueued(id)` e `clearQueue()`; l'evento numerico `queue` resta compatibile. La richiesta `prompt` originale riceve il risultato del testo modificato.

## Ultimo modello scelto

Le selezioni esplicite con `--model`, `/model`, picker, RPC `model` o `/branch --model` diventano il modello iniziale per le nuove sessioni, anche in altre cartelle. La preferenza si salva in `~/.kairos/last-model.json`, con copia precedente `.bak`, senza riscrivere `config.json`.

La precedenza è: `--model` → modello del progetto fidato → ultimo modello scelto → modello personale configurato → default incluso. Una sessione ripresa conserva il proprio modello salvo override CLI esplicito. L'avvio automatico con un modello di progetto, le domande `/btw` e `--check-models` non cambiano la preferenza manuale. Un effort personale incompatibile con il nuovo modello ripiega su `auto`; un effort esplicito incompatibile viene rifiutato.
