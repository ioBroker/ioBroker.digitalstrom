![Logo](admin/digitalstrom.png)
# ioBroker.digitalstrom

[![GitHub release](https://img.shields.io/github/v/release/mrandreschmitz/ioBroker.digitalstrom)](https://github.com/mrandreschmitz/ioBroker.digitalstrom/releases)
![Test and Release](https://github.com/mrandreschmitz/ioBroker.digitalstrom/workflows/Test%20and%20Release/badge.svg)

**English version: [README.md](README.md)**

## Digitalstrom-Adapter für ioBroker

Anbindung von digitalSTROM-Geräten über den DSS (digitalSTROM-Server)

> Dies ist ein gepflegter Fork von [ioBroker/ioBroker.digitalstrom](https://github.com/ioBroker/ioBroker.digitalstrom)
> von Apollon77, der seit 2021 nicht mehr aktualisiert wurde. Die zugrunde liegende Bibliotheksschicht
> wurde ersetzt, der Admin-Dialog neu gebaut, neben der klassischen Schnittstelle wird die moderne
> Smart Home API des dSS genutzt und eine größere Zahl von Laufzeitfehlern behoben.
> Einzelheiten stehen im Changelog.
>
> Dieser Fork sendet **keine** Fehlerberichte: Das Sentry-Plugin des Originaladapters wurde entfernt,
> weil dessen Berichte in einem Projekt der ioBroker-Organisation gelandet wären, auf das dieser Fork
> keinen Zugriff hat.

## Installation

Dieser Fork wird direkt von GitHub installiert. Der digitalstrom-Adapter in der normalen
Adapterliste von Admin ist der ursprüngliche Adapter, nicht dieser Fork.

Verwende in Admin die Option „Beliebig / Custom Install" mit der URL
https://github.com/mrandreschmitz/ioBroker.digitalstrom oder gib auf der Kommandozeile
`iobroker url https://github.com/mrandreschmitz/ioBroker.digitalstrom` ein.

Voraussetzungen: Node.js 22 oder neuer, js-controller 6.0.11 oder neuer und Admin 7.6.17 oder neuer. Die
Objekt-Warngrenze im Reiter „Einstellungen" braucht js-controller 7.1.0 oder neuer.

## Zwei Schnittstellen, ein Team

Ein digitalSTROM-Server bietet zwei Schnittstellen mit unterschiedlichen Stärken — und dieser
Adapter nutzt bewusst beide als Team:

* Die **klassische Schnittstelle** (App-Token) ist der Basiszugang des Adapters: Tasterdrücke,
  Sensorwerte und Binäreingänge kommen als **Ereignisse in Echtzeit** an, und **jeder
  Schaltbefehl** läuft über sie.
* Die **Smart Home API** (`/api/v1`, dSS-Firmware 1.19 oder neuer) ist der Lese-Turbo:
  **alle Zählerwerte und alle Geräte-Ausgangswerte** (Helligkeit, Rollladenpositionen, Farbwerte)
  kommen gebündelt in **je einem einzigen Request** statt in einem Request pro Wert. Obendrein
  liefert sie die Solltemperaturen der Raumregelung jeder Zone, die in digitalSTROM vergebenen
  Szenennamen und einen Änderungs-Websocket, über den der Adapter Werte abgleicht, die an
  ioBroker vorbei geändert wurden — etwa von einer Dritt-App. Ein fahrender Rollladen trägt darin
  keinen Wert, aber seine ganze Fahrt: Die Position wird berechnet und folgt der Bewegung live.

**Beide öffnet derselbe Zugang**: das App-Token aus der Einrichtung. Die Smart Home API braucht
keinen zweiten Schlüssel — ein eigener API-Schlüssel bleibt als Option verfügbar und wird
bevorzugt genutzt, wenn einer eingetragen ist.

Zusammen heißt das: Der Adapter **startet in Sekunden statt Minuten**, auch auf großen Anlagen,
Werte sind nach Szenenaufrufen schnell wieder frisch — und der dSS trägt spürbar weniger Last,
bequem innerhalb der digitalSTROM-Anfragerichtlinien. Und das bei voller Zuverlässigkeit: Jede
Aufgabe der Smart Home API fällt automatisch auf den klassischen Weg zurück, der Adapter bleibt
also auch mit nur der klassischen Schnittstelle vollständig funktionsfähig.

Der **Status-Tab** der Instanzeinstellungen zeigt diese Arbeitsteilung live — welche
Schnittstelle gerade Ereignisse, Zählerwerte und Ausgangswerte liefert und wie viel jede von
ihnen in den letzten 10 Minuten wirklich getan hat:

![Status-Tab: die Arbeitsteilung der beiden Schnittstellen, live](docs/admin-status-de.png)

## Konfiguration

Der Verbindungs-Tab führt durch die Einrichtung: die Serveradresse (einmal eingetragen — sie
bedient beide Schnittstellen), das App-Token als Basiszugang (direkt aus dem Dialog mit deinen
dSS-Anmeldedaten erstellt, die nicht gespeichert werden – die Instanz muss dafür laufen) und ein
Schalter für die empfohlene Beschleunigung. **Das App-Token öffnet beide Schnittstellen**, die Smart Home API braucht also
keinen zweiten Zugang — ein eigener API-Schlüssel bleibt hinter einem Link als Option verfügbar:

![Reiter „Verbindung" des Konfigurationsdialogs](docs/admin-connection-de.png)

Abfrageintervall, Verhalten des Adapters und die Objekt-Warngrenze liegen im Einstellungen-Tab:

![Reiter „Einstellungen" des Konfigurationsdialogs](docs/admin-settings-de.png)

Der Hinweise-Tab fasst die „Warum zwei Schnittstellen?"-Geschichte und den Zertifikatshinweis
direkt im Dialog zusammen:

![Reiter „Hinweise" des Konfigurationsdialogs](docs/admin-notes-de.png)

Zusätzlich zu den Verbindungsdaten stehen folgende Einstellungen zur Verfügung:

* **Zähler- und Ausgangswerte über die Smart Home API lesen**: Ein Request bedient alle Klemmen,
  ein Status-Request alle Geräteausgänge. Benötigt einen dSS mit Firmware 1.19 oder neuer — und
  sonst nichts: Das App-Token öffnet auch diese Schnittstelle. Gefahrlos aktivierbar: Wann immer
  die Smart Home API nicht antwortet, übernimmt automatisch der klassische Weg und der Adapter
  läuft unverändert weiter. Bei einer neuen Instanz ist der Schalter aus – du findest ihn in Schritt 3
  des Verbindungs-Tabs.

* **Datenabfrageintervall**: Intervall, in dem die Zählerdaten („Energy Meter") von den dSM-Geräten
  abgefragt werden. Standard 100 s, Minimum 60 s. Die digitalSTROM-Regeln 8 und 9 erlauben höchstens
  einen zyklischen Lesezugriff pro Minute und Klemme. Ein Zyklus liest zwei Werte je Klemme
  (`getConsumption` und `getEnergyMeterValue`), und der Timer für den nächsten Zyklus startet erst,
  wenn beide beantwortet sind — ein Zyklus dauert dadurch rund 20 s länger als das eingestellte
  Intervall. An einer echten Anlage gemessen: 60 s ergeben ~1,5 Anfragen pro Minute und Klemme,
  100 s genau 1,0. Deshalb ist 100 s der Standard. Kleinere Werte bleiben ab 60 s möglich,
  überschreiten die Vorgabe aber; einen Wert zwischen 1 und 59 s hebt der Adapter auf 60 s an. Mit
  `0` wird die Abfrage vollständig deaktiviert. Ein leeres Feld oder ein Eintrag, der keine Zahl ist,
  fällt auf den Standard zurück. Mit eingeschalteter Smart Home API liest ein einziger Request pro
  Zyklus die Werte aller Klemmen.
* **Szenen-Voreinstellungswerte verwenden**: digitalSTROM arbeitet vor allem mit Szenen, und für Licht
  und Rollläden haben viele Szenen einen bekannten Ausgangswert. Ist die Option an und wird eine Szene
  aufgerufen, schreibt der Adapter diesen Voreinstellungswert sofort in die Ausgangs-States; die echten
  Werte werden kurz danach gelesen (solange **Ausgabewerte der Geräte aktiv abfragen** an ist). Mit
  eingeschalteter Smart Home API verwenden Rollläden keinen Voreinstellungswert: Solange die
  Ausgangswerte abgefragt werden, folgt ihre echte Position der Fahrt. Ein Voreinstellungswert kann vom
  echten Wert abweichen, etwa wenn an einem Gerät eine lokale Priorität gesetzt ist.
* **Ausgabewerte der Geräte aktiv abfragen**: Der Adapter liest die Ausgangswerte aller Geräte beim Start
  und nach Szenen, die ein Gerät betreffen. Ohne Smart Home API laufen diese Abfragen einzeln über
  den digitalSTROM-Bus, mit ihr kommen die Werte gebündelt in einem Status-Request. Falls die Abfragen
  in deiner Installation stören, kannst du die Funktion abschalten. Die Option steuert **ausschließlich
  das Lesen** von Ausgangswerten. Das **Schreiben** (Jalousieposition, Lamellenwinkel, Dimmwert)
  funktioniert unabhängig davon immer.
* **Unbekannte Objekte beim Start löschen**: Ist die Option aktiv, werden beim Adapterstart alle
  ioBroker-Objekte gelöscht, die nicht Teil der aktuellen DSS-Struktur sind. Achtung: Auch Objekte von
  nur vorübergehend nicht erreichbaren Geräten (z. B. einer stromlosen Klemme) werden gelöscht —
  einschließlich ihrer eigenen Einstellungen wie History- oder InfluxDB-Konfiguration. Deshalb ist die
  Option standardmäßig aus; verwaiste Objekte werden dann nur im Log aufgelistet.
* **TLS-Zertifikat des DSS prüfen**: Standardmäßig wird das Zertifikat des DSS nicht geprüft, weil der
  DSS ein selbstsigniertes Zertifikat verwendet. Aktiviere die Option nur, wenn dein DSS ein gültiges
  Zertifikat besitzt. Siehe den Sicherheitshinweis weiter unten.

Nachdem du die Einstellungen mit einem App-Token gespeichert hast, startet der Adapter automatisch neu.
Er liest die Struktur deiner Anlage aus (Etagen, Räume, Gruppen, Stromkreise und Geräte) und legt dafür
die ioBroker-Objekte an. Je nach Größe der Anlage und Leistung deines Systems dauert das eine Weile –
mehrere tausend Objekte sind schnell erreicht, bitte hab Geduld. Auf die Ereignisse des dSS hört der
Adapter dabei schon (siehe „Hinweise zum Verhalten").

Sobald die Statusanzeige der Instanz grün ist und im Log „Subscribed to states …" erscheint, ist alles
bereit und du kannst zum Beispiel:

* Szenen für Wohnung, Räume, Gruppen oder einzelne Geräte aufrufen und zurücknehmen
* Status- und Sensorwerte lesen; bei Räumen können Sensorwerte auch gesetzt werden
* Werte von Binäreingängen, Sensoren, Tastern und Ausgängen sehen

### Objekt-Warngrenze

ioBroker (ab js-controller 7.1.0) warnt, wenn eine Instanz **mehr Objekte hat als ihre Objekt-Warngrenze**.
Eine digitalSTROM-Anlage kommt schnell auf mehrere Tausend Objekte, deshalb schlägt dieser Adapter 10000 vor.
Ältere Instanzen stehen oft noch auf 5000 – bei mehr Objekten warnt ioBroker dann bei jedem Start, obwohl
alles in Ordnung ist.

Die Karte **Objekt-Warngrenze** im Reiter „Einstellungen" zeigt die eingestellte Grenze, den Adapter-Standard
und den Datenpunkt. Zum Ändern eine ganze Zahl wie `10000` eintragen und **Speichern** klicken:

![Objekt-Warngrenze ändern](docs/admin-warnlimit-save-de.png)

Gut zu wissen:

* Die Grenze steuert nur die Warnung. Sie legt keine Objekte an, löscht oder versteckt keine und macht
  digitalSTROM und ioBroker weder langsamer noch schneller.
* Die neue Grenze gilt ab dem **nächsten Start** der Instanz. Das Speichern der Grenze allein startet sie nicht neu.
* Eine bereits angezeigte Warnung verschwindet nicht von selbst – bestätige sie in Admin unter **Hosts**.
* Sinnvoll ist ein Wert etwas über der tatsächlichen Objektanzahl; die nennt die Warnung im Log
  („This instance has … objects").

### Sicherheitshinweis zur Zertifikatsprüfung

Die Option **TLS-Zertifikat des DSS prüfen** ist standardmäßig deaktiviert und bleibt es auch — ein
digitalSTROM-Server wird mit einem selbstsignierten Zertifikat ausgeliefert, eine standardmäßig
aktivierte Prüfung würde also jede bestehende Installation lahmlegen.

Was das bedeutet: Die Verbindung zum DSS ist verschlüsselt, aber der Adapter überprüft nicht, *mit wem*
er spricht. In einem Netzwerk, das du selbst kontrollierst, ist das in der Regel vertretbar. Wer den
Datenverkehr innerhalb deines Netzwerks umleiten kann (ARP-Spoofing, kompromittierter Router,
unvertrauenswürdiges WLAN), könnte sich jedoch zwischen ioBroker und DSS setzen und würde dann den
App-Token und jeden Befehl mitlesen.

Empfehlungen, in dieser Reihenfolge:

1. Betreibe DSS und ioBroker in einem vertrauenswürdigen, abgetrennten Netzsegment und route die
   Verbindung zum DSS nicht über das Internet oder ein fremdes WLAN.
2. Besitzt dein DSS ein Zertifikat von einer öffentlichen CA (z. B. hinter einem Reverse Proxy mit
   gültigem Zertifikat) oder aus einer eigenen CA, der Node.js auf dem ioBroker-Host bereits vertraut
   (etwa über die Umgebungsvariable `NODE_EXTRA_CA_CERTS`), trage den Hostnamen ein, für den das
   Zertifikat ausgestellt ist, und aktiviere die Option.
3. Migrationspfad für eine Prüfung mit dem originalen, selbstsignierten Zertifikat: Dafür wird das
   Zertifikat selbst benötigt. Der Adapter unterstützt derzeit weder eine eigene CA-Datei noch einen
   Zertifikats-Fingerprint. Technisch wäre beides möglich (`ca` bzw. `checkServerIdentity` des
   Node.js-TLS-Agents) und ist als mögliche Erweiterung vorgemerkt. Bis dahin sind Weg 1 oder 2 die
   richtige Wahl.

Der App-Token und ein eigener API-Schlüssel werden verschlüsselt gespeichert (`encryptedNative`),
nicht an andere Adapter weitergegeben (`protectedNative`), nicht ins Log geschrieben und im
Admin-Dialog maskiert dargestellt.

## Objekt- und State-Struktur

Der Adapter stellt zwei Datenstrukturen bereit: die Wohnungsstruktur mit Etagen, Räumen (Zonen) und
Gruppen sowie zusätzlich die Struktur der Klemmen/dSMs mit den daran angeschlossenen Geräten und
deren Detaildaten.

In den Strukturen kommen mehrere Datentypen vor:

* **Szenen** sind als Schalter umgesetzt. Der Wert `true` sendet einen `callScene`-Befehl für diese
  Szene, der Wert `false` einen `undoScene`-Befehl — ob „undo" ein gültiger Befehl ist, entscheidet
  der DSS. Löst der DSS selbst ein `callScene` oder `undoScene` als Event aus, wird die betroffene
  Szene mit `ack=true` auf `true` bzw. `false` gesetzt. Szenen, die eine Bewegung befehlen statt
  eine Position zu wählen (Stopp, Increment, Decrement, Area Stepping Continue, Impuls), fallen
  von selbst wieder auf `false` zurück, siehe die Hinweise zum Verhalten.
* **States** aus dem System werden angezeigt und sind schreibgeschützt. Die benutzerdefinierten States
  der Wohnung (`apartment.userStates`) lassen sich auch setzen – der neue Wert wird an den DSS
  weitergegeben.
* **Sensorwerte** werden über Events aktualisiert. Die meisten Sensorwerte eines Raums lassen sich auch
  schreiben.
  Änderungen werden als `pushSensorValue` an den Server geschickt; ob der Wert akzeptiert wird,
  entscheidet der Server. Relevant ist das vor allem für Temperatur- und Feuchtewerte.

### Objekte und States der Wohnung

![Apartment Objects](img/dss-apartment.png)

Für die Wohnung wird eine Struktur „Etage"."Raum" angelegt, darunter jeweils:

* pro Gerätegruppe ein Unterordner mit den verfügbaren Gruppenszenen
* die Szenen dieses Raums
* die States dieses Raums, in Räumen, die die Klimasteuerung passiv kühlt, auch das schreibgeschützte
  `passiveCooling`
* die Sensorwerte dieses Raums

Auf Wohnungsebene sind alle Gerätegruppen mit ihren Szenen verfügbar. Ebenfalls auf Wohnungsebene
liegen Sensoren (auch Außenwerte), States und benutzerdefinierte States.

### Objekte und States der Geräte

![Devices Objects](img/dss-devices.png)

Die Geräte sind als „Klemme/dSM"."Geräte-ID" strukturiert, darunter jeweils:

* Geräteszenen, die ausschließlich dieses Gerät ansprechen
* Gerätesensoren, sofern vom System gemeldet — Werte können also leer bleiben
* Ausgangswerte (z. B. Helligkeit bei Licht, Position und Winkel bei Rollladen/Jalousie) direkt
  unterhalb des Geräts. Die vollständige benannte Funktionalität gibt es für digitalSTROM-Licht und
  -Rollladen/Jalousie; ein Joker (Schwarz) mit Ausgang — etwa eine geschaltete Steckdose — wird
  ebenfalls gelesen, und vDC-Geräte (Hue, Sonos) erreichen ihre Kanäle über den benannten
  Kanal-Lesebefehl. Gerätesensoren und Ausgangskanäle ohne Schreibweg sind schreibgeschützt — z. B.
  alle Kanäle einer mehrkanaligen vDC-Lampe (Hue-Farb- und Farbtemperatur-Lampen, Helligkeit
  eingeschlossen) und die Sonos-Kanäle.
* Taster und Binäreingänge, ebenfalls als States und schreibgeschützt

## Hinweise zum Verhalten

* **Schnelle aufeinanderfolgende Schreibvorgänge**: Wird ein neuer Wert auf denselben Ausgang
  geschrieben, während ein älterer noch in der Warteschlange steht, ersetzt der neuere den älteren
  (Last-write-wins), um die Anfragegrenzen des DSS einzuhalten. Der ersetzte Auftrag wird als
  „superseded" gemeldet und sein Wert nie als geschrieben quittiert. Ein bereits an den DSS gesendeter
  Schreibvorgang wird nie ersetzt — der neuere Wert geht danach raus.
* **Hostfeld**: Akzeptiert werden IP-Adressen, DNS-Namen, vollständige URLs und IPv6-Adressen (in
  eckigen Klammern). Ohne expliziten Port wird 8080 verwendet. Anmeldedaten, Pfade oder Query-Strings
  im Hostfeld werden abgelehnt.
* **Fahrender Ausgang**: Während ein Rollladen fährt, meldet der DSS keinen Wert, kündigt aber die
  Fahrt an — Startwert, Zielwert und das Zeitfenster dafür. Daraus wird die Position während der
  Fahrt berechnet und folgt der Bewegung. In dem Moment, in dem das angekündigte Ende verstreicht,
  wird nichts geschrieben: Der State behauptet das Ziel also nie, bevor der Rollladen dort ist. Der
  echte Wert folgt rund zwei Sekunden später.
* **User-States**: Ein User-State geht nur dann an den DSS, wenn sich sein Wert wirklich ändert. Ein
  Skript, das denselben Wert alle paar Minuten neu setzt, erzeugt damit gar keine Anfragen. Der vom
  DSS gemeldete Wert wird aus beiden Richtungen mitgeführt, damit ein im DSS geänderter State nie
  fälschlich als unverändert gilt.
* **Momentane Szenen und Tastendrücke**: Stopp, Increment, Decrement, Area Stepping Continue und Impuls sind
  Befehle, keine Positionen — der dSS schickt dafür einen callScene und nie den undoScene, der
  ihn wieder lösen würde. Ihr `scenes.<Name>` geht deshalb auf true und fällt eine halbe Sekunde
  später auf false zurück, damit eine Regel bei jedem Druck feuert statt nur beim allerersten.
  Eine Wiederholung innerhalb dieser halben Sekunde spannt die Freigabe neu, statt eine zweite
  Flanke zu erzeugen — ein Wandtaster wiederholt seinen Stopp. `scenes.sceneId` wird nicht
  freigegeben und beantwortet weiterhin, welche Szene zuletzt gerufen wurde. `<Gerät>.<n>.button`
  folgt derselben Regel aus demselben Grund: Der dSS meldet einen Druck und nimmt ihn nie
  zurück, der State geht deshalb auf true und fällt eine halbe Sekunde später zurück.
  `buttonClickType` und `buttonHoldCount` werden nicht freigegeben — sie beschreiben den Druck,
  der stattgefunden hat, nicht den Moment.
* **Die ersten zwei Minuten nach einem Start**: Der Adapter abonniert die dSS-Ereignisse, bevor
  er seine Objekte angelegt hat, damit auf einer großen Anlage während des Aufbaus fast nichts
  verlorengeht. Sensorwerte, States und Binäreingänge aus diesem Fenster werden angewendet,
  sobald die Objekte existieren — auf die Startaufnahme obendrauf. Szenenaufrufe und
  Tastendrücke aus diesem Fenster werden bewusst NICHT nachgeholt, auf einen minutenalten Druck
  zu reagieren wäre schlimmer als ihn zu verpassen. Die zuletzt gerufene Szene jeder ZONENGRUPPE
  wird am Ende des Starts neu gelesen, eine dort verpasste Gruppenszene ist also korrigiert.
  Eine Szene, die der dSS für ein einzelnes Gerät gemeldet hat, wird nicht nachgeholt — sie
  bleibt stehen, bis der nächste Aufruf sie erreicht.
* **Ein Zustand, den der dSS nicht kennt**: Einige Ein/Aus-Zustände, zum Beispiel den Raumzustand
  `heating`, meldet der dSS als „unknown“, solange er keine Information dazu hat. Zeigt der Adapter
  einen solchen State als true/false, hat er keinen Wert (null), bis der dSS active oder inactive
  meldet; ein State mit dem Wortlaut des dSS, etwa ein User-State oder ein Gerätezustand, zeigt das
  Wort „unknown“. Wer null in einen State schreibt, schickt damit nichts an den dSS.
* **Ein dSS, der nicht erreichbar ist**: Antwortet der dSS beim Start nicht (etwa während er neu
  startet, ein Update installiert oder das Netzwerk ausgefallen ist), läuft der Adapter weiter und
  fragt alle 5 Minuten erneut, statt sich selbst neu zu starten. Die erste fehlgeschlagene Prüfung
  steht als Fehler im Log, mit dem Hinweis, was zu prüfen ist. Weitere Prüfungen erscheinen nur auf
  debug, ein anderer Fehler wird noch einmal gemeldet. Eine Info-Zeile sagt, wann der dSS wieder
  antwortet und wie lange er nicht erreichbar war, danach läuft der Start weiter. Bis dahin bleibt
  `info.connection` auf false. Ein dSS, der antwortet, aber das App-Token ablehnt, erscheint als
  abgelehnte Anmeldung mit dem Hinweis, das Token zu prüfen, und wird genauso erneut gefragt.

## Bekannte Einschränkungen und Systemeigenheiten

* Das digitalSTROM-System ist von Haus aus szenenzentriert: Die meisten Aktionen sind
  Szenenaufrufe statt einzelner Wertänderungen, und der Adapter bildet dieses Modell ab. Mit
  aktivierter Smart Home API kommen die echten Ausgangswerte zusätzlich gebündelt in einem
  Status-Request an und bleiben so ohne zusätzlichen Busverkehr frisch.
* Werte können leer bleiben, wenn das System sie nicht meldet.
* Binäreingänge wurden ursprünglich ohne passende Geräte zum Testen implementiert. Inzwischen ist
  belegt, dass sie funktionieren: Bewegungsmelder und Fenstergriffe melden darüber. Der Zustand behält die
  Zahl, die der DSS meldet, damit Verlaufsdaten vergleichbar bleiben, die Zahlen sind aber benannt:
  `inactive`/`active` bei einem normalen Binäreingang und `closed`/`open`/`tilted` bei einem
  Fenstergriff, der drei statt zwei Stellungen meldet.
* Die vollständige benannte Ausgangsfunktionalität — Helligkeit, Position und Winkel — ist für
  digitalSTROM-Licht (Gelb, GE-) und -Rollladen/Jalousie (Grau, GR-) umgesetzt, und eine vDC-Lampe
  mit nur einem Ausgangskanal (eine dimmbare Hue-Lampe wie die LWV001) nimmt ebenfalls einen
  Helligkeitswert an. Eine vDC-Lampe mit mehreren Kanälen (Hue-Farb- und Farbtemperatur-Lampen)
  wird in allen Kanälen gelesen, die Helligkeit eingeschlossen, und über ihre Szenen geschaltet und
  gedimmt. Bei einer Jalousie mit Innen- und Außenkanälen (GR-KL300) lassen sich nur Position und
  Winkel außen setzen. Ein Joker (Schwarz) mit Ausgang wird ebenfalls gelesen und folgt seinen
  Szenen, sein Wert bleibt aber der reine, schreibgeschützte Ausgangswert ohne benannte Bedeutung.
* vDC-Geräte (Hue-Lampen, Sonos-Player) lesen ihre Ausgangskanäle über den benannten Lesebefehl
  `device/getOutputChannelValue2` — gemessen an einem dSS20 1.19.13. Lautstärke und Ein-Zustand von
  Sonos-Playern sowie die Farbwerte von vDC-Lampen kommen mit und ohne Smart Home API an, und ein
  dSS, der den Aufruf für ein Gerät ablehnt, wird pro Gerät gemerkt. Über die Ausgangskanäle hinaus
  gibt es keine vDC-spezifische Behandlung — Logs und Rückmeldungen zu anderer vDC-Hardware sind
  weiterhin willkommen.
* Die Raumtemperaturregelung ist für die Räume umgesetzt, die der DSS tatsächlich regelt: Reglermodus
  und Reglerzustand werden gelesen, der Betriebsmodus folgt den Szenen der Gruppe 48 und ist
  schreibbar, und der Sollwert jedes Betriebsmodus wird gelesen und kann geändert werden. Räume ohne
  aktiven Regler erhalten bewusst keine dieser Objekte.
* Die Lüftung ist über die Gruppenszenen, den Lüftungsstatus der Wohnung und die beiden booleschen
  Ausgangskanäle (Schwenkmodus, automatische Intensität) abgedeckt. Darüber hinaus haben
  Lüftungsgeräte keine eigene Funktionalität, da keine passende Hardware zum Testen vorlag. Logs und
  Rückmeldungen sind willkommen.
* Erscheint der Konfigurationsdialog nur als schmaler Streifen von etwa 150 px unter dem Titel,
  aktualisiere Admin: Admin 8.0.11 hat Adapter-Dialoge wie diesen so angezeigt, ab Admin 8.0.15
  erscheinen sie wieder normal.

## Fehler melden und Funktionswünsche

Bitte nutze dafür die [Issues dieses Forks](https://github.com/mrandreschmitz/ioBroker.digitalstrom/issues).

Am hilfreichsten ist es, den Adapter auf den Loglevel „debug" zu stellen (Instanzen → Expertenmodus →
Spalte Loglevel) und die Logdatei anschließend von der Festplatte zu holen (Unterverzeichnis `log` im
ioBroker-Installationsverzeichnis, nicht aus dem Admin — dort werden Zeilen abgeschnitten). Bitte gib
im Issue an, was zu welchem Zeitpunkt im Log zu sehen sein sollte.

## Danksagung und Lizenz

Dieser Adapter wurde ursprünglich von **Apollon77 &lt;iobroker@fischer-ka.de&gt;** geschrieben und unter
der MIT-Lizenz auf [ioBroker/ioBroker.digitalstrom](https://github.com/ioBroker/ioBroker.digitalstrom)
veröffentlicht. Das Verdienst an der ursprünglichen Arbeit gebührt ihm.

Dieses Repository ist ein Fork, der die Pflege ab Version 2.4.0 fortsetzt (André Schmitz, 2026). Es
wird unter derselben MIT-Lizenz veröffentlicht; der ursprüngliche Copyright-Hinweis bleibt in
[LICENSE](LICENSE) unverändert erhalten.

## Changelog

Der vollständige Changelog inklusive der Historie von Apollon77 steht in der englischen Fassung:
[README.md](README.md#changelog). Hier die Einträge der gepflegten Versionen auf Deutsch.

### 2.4.27 (2026-10-09)

* **Namen, die der dSS noch mit HTML-Codes gespeichert hat, erscheinen mit den richtigen Zeichen.** 2.4.26
  korrigierte einen solchen Namen nur, wenn der dSS ihn heute ohne die Codes meldet. Der dSS behält einen Namen aber
  so, wie ältere Firmware ihn gespeichert hat, bis er neu gesetzt wird – `getCircuits` kann also weiter
  `Büro &amp; Duschbad` liefern. Auf einer echten Installation behielten drei Klemmen-Ordner diesen Namen nach dem
  Update, ohne dass eine Korrektur im Log stand. Jetzt wird jeder Name des dSS decodiert, bevor das Objekt entsteht;
  die einmalige Korrektur aus 2.4.26 greift damit beim ersten Start, und das Log meldet sie. Ein Name, den Sie selbst
  geändert haben, bleibt, und keine ID ändert sich
* **`INVALID scenecall` ist weg.** Ein Szenenaufruf ohne Szenen-State wird mit Raum, Gruppe und Szene geloggt. Zwei
  Fälle sind erwartet und stehen auf Debug: Die Heizungssteuerung ruft zu ihren Schaltzeiten die Szenen der Gruppe 48
  in jedem Raum auf, auch in Räumen ohne Heizung, und ein Befehl wie Stop auf Gruppenebene existiert nur als
  Szenen-State eines Geräts. Jeder andere Fall wird einmal pro Lauf auf Info gemeldet, danach auf Debug
* **Zählerstände werden auf ganze Wattstunden gerundet.** `EnergyMeterValue` hatte Werte wie
  `4009.7331175000004` kWh, jetzt `4009.733`. Gerundet wird der Gesamtstand, nicht der Schritt, es summiert sich also
  nichts auf
* **Unveränderte Messwerte werden nicht erneut geschrieben.** `PowerConsumption` und `EnergyMeterValue` werden alle
  100 s abgefragt und bisher jedes Mal geschrieben, obwohl zwei Drittel der Leistungs- und ein Drittel der
  Zählerwerte den vorigen Wert wiederholten. Sie werden jetzt bei einer Änderung geschrieben, der Zeitstempel dieser
  States bewegt sich also nur noch mit einer Änderung; `info.apiActivity` zeigt, dass weiter gelesen wird
* **Ein Wert, den ein anderer Adapter oder ein Skript in einen abgefragten State schreibt, wird wieder korrigiert.**
  Der Adapter merkt sich, was in jedem State steht, damit eine Abfrage einen unveränderten Wert überspringen, einen
  fremden aber korrigieren kann. Die Bestätigung eines fremden Schreibzugriffs landete unter der ID mit Namespace,
  verglichen wurde ohne – ein solcher Wert fiel also nie auf. Das betraf auch den Abgleich der Geräteausgänge
* **Das Debug-Log ist etwa halb so lang.** Ein Befehl (`ack = false`) steht weiter auf Debug; die Bestätigungen,
  meist die eigenen Schreibzugriffe des Adapters und `info.apiActivity` alle 30 s, stehen auf Silly
* **Ein unbekannter Addon-State wird einmal auf Info gemeldet.** States von dSS-Addons ohne Objekt, etwa
  `operationmode.3.NotUsed` der Heizungssteuerung, waren nur im Debug-Log zu sehen. Sie werden jetzt wie jeder
  andere unbekannte State einmal pro Lauf gemeldet. Die internen Hilfs-States `<dsuid>_open-tilded` und
  `queue-active` bleiben auf Debug

### 2.4.26 (2026-09-26)

* **Räume melden die Heizung nicht mehr als aktiv, solange der dSS es nicht weiß.** Solange er keine Information
  hat, beantwortet der dSS den Raumzustand `heating` mit „unknown“. Der Adapter wertete dieses Wort als wahr –
  jeder Raum zeigte die Heizung aktiv, und jeder Start schrieb eine Warnung pro Raum ins Log. Ein solcher Zustand
  bleibt jetzt leer (null), bis der dSS active oder inactive meldet, und die Warnungen sind weg. Das gilt für jeden
  State, den der Adapter als true/false zeigt. States mit dem Wortlaut des dSS, etwa die Gerätezustände
  (`states.0`, ...) und die User-States, zeigen weiter das Wort „unknown“. Ein null, das ein Skript in einen State
  schreibt, geht nicht mehr als „inactive“ an den dSS
* **States, die der Adapter nicht schreiben kann, sind als schreibgeschützt markiert.** Das betrifft die Farb- und
  Helligkeitskanäle mehrkanaliger vDC-Lampen (Hue), Lautstärke und Ein-Zustand von Sonos-Playern, die Innenkanäle
  von GR-KL300-Jalousien, den Ausgangswert eines Jokers, alle Gerätesensoren, die Außensensoren und
  `buttonClickType`. Diese States trugen bisher gar kein Schreib-Flag, der Admin bot sie deshalb zum Bearbeiten
  an, obwohl eine Änderung nichts bewirkte. Die schreibbaren States (Szenen, Licht, Rollläden, einkanalige
  Ausgänge, Raumsensoren, User-States, die Sollwerte unter `temperatureControl.setpoints`) bleiben, wie sie sind.
  Ein Gerätesensor wie „Room Temperature Set Point“ meldet nur den Wert des Geräts und ist ebenfalls
  schreibgeschützt; ein vis-Widget oder Skript, das ihn noch beschreibt, löst jetzt die js-controller-Warnung
  `Read-only state ... has been written without ack-flag` aus. Die Raumtemperatur stellen Sie über
  `temperatureControl.setpoints.*` oder `OperationMode`. Das Flag wird beim ersten Start automatisch korrigiert
* **Namen mit HTML-Codes werden einmal korrigiert.** Ältere dSS-Firmware legte die Namen von Klemmen, Räumen und
  Geräten mit HTML-Codes ab, zum Beispiel `Schlafen &amp; Bad` statt `Schlafen & Bad`, und die damals angelegten
  Objekte behielten diesen Namen – der Adapter lässt Objektnamen bewusst stehen, damit eigene Umbenennungen
  erhalten bleiben. Ein solcher Name wird jetzt einmal durch den Namen ersetzt, den der dSS heute meldet, und das
  Log vermerkt es. Einen Namen, den Sie selbst geändert haben, rührt der Adapter nicht an
* **Der Startbericht bittet beim zweiten Eingang eines 2-Wege-Tasters nicht mehr um ein Issue.** Sind die
  Tastereingänge einer Rollladenklemme wie der GR-KL300 als 2-Wege-Taster verdrahtet, koppelt der dSS den zweiten
  Eingang an den ersten und führt das Paar als ein Gerät, behält aber einen State für den zweiten Eingang. Der
  Adapter fand zu diesem State kein Gerät und bat um ein GitHub-Issue. Jetzt nennt er einen solchen State auf
  debug zusammen mit dem Gerät, zu dem er gehört, und die Info-Zeile listet nur noch States, die sich wirklich
  nicht zuordnen lassen
* **Ein Neustart, den der Adapter selbst anfordert, erscheint nicht mehr als Warnung.** Statt
  `Terminated (-100): Without reason` protokolliert ioBroker jetzt `Terminated (START_IMMEDIATELY_AFTER_STOP):
  restarting because ...` mit dem Grund auf Info-Ebene. Die Instanz fährt vor dem Neustart sauber herunter. Im
  Compact-Modus läuft die alte Instanz dadurch nicht mehr neben der neuen weiter, und der Neustart folgt nach 1 s
  statt nach 30 s. Im Compact-Modus schreibt der Adapter den Grund in eine eigene Info-Zeile, und die Zeile von
  ioBroker lautet `Without reason`: Einen dort übergebenen Grund würde js-controller als Warnung des Hosts
  protokollieren
* **Ein nicht erreichbarer dSS füllt nicht mehr das Log.** Solange der dSS beim Start nicht erreichbar war,
  beendete der Adapter alle 5 Minuten seinen Prozess und startete neu: Eine Nacht auf einer echten Anlage brachte
  102 Neustarts, 204 Fehlerzeilen und 101 Warnungen. Jetzt läuft er weiter und fragt alle 5 Minuten erneut. Es gibt
  einen Fehler mit dem Hinweis, was zu prüfen ist, und eine Info-Zeile mit der Dauer, sobald der dSS wieder
  antwortet. Ein anderer Fehler zwischendurch, etwa eine abgelehnte Anmeldung, wird noch einmal gemeldet. Lehnt
  der dSS das App-Token ab, meldet der Adapter eine abgelehnte Anmeldung und nicht „nicht erreichbar“
* **Ein State des dSS, den der Adapter noch nicht kennt, wird einmal genannt.** `Unhandled State Change` für einen
  State ohne Objekt erschien bei jeder Änderung auf Info-Ebene: Ein Raum, der seine Schwelle für passive Kühlung
  überschritt, schrieb dieselbe Zeile viermal in fünf Stunden. Jetzt steht sie einmal pro Lauf auf Info-Ebene und
  jede weitere Änderung nur noch auf debug. Die Zeile sagt, dass ein State, den der dSS nach dem Start des Adapters
  angelegt hat, beim nächsten Start sein Objekt bekommt, und bittet nur dann darum, den Namen zu melden, wenn er
  auch nach einem Neustart noch erscheint
* **Räume mit passiver Kühlung haben einen schreibgeschützten State dafür.** Die Klimasteuerung des dSS führt für
  jeden Raum, den sie passiv kühlt, einen Zustand: aktiv, solange die Raumtemperatur über der für diesen Raum
  eingestellten Schwelle für passive Kühlung liegt, inaktiv, sobald sie darunter sinkt. Der dSS legt solche
  Zustände seiner Apps getrennt von den übrigen States ab, deshalb las der Adapter ihn nie und schrieb jede
  Änderung nur als `Unhandled State Change` ins Log. Jetzt liest er ihn beim Start und legt
  `apartment.<Etage>.<Raum>.states.passiveCooling` (true/false) an, mit einem Wert direkt nach dem Start und
  jeder Änderung, die der dSS meldet. Ein dSS, der diese Zustände nicht anbietet, startet wie bisher. Schlägt das
  Lesen bei einem Start fehl, bleiben die States des letzten Starts mit ihrem letzten Wert stehen, bis der dSS eine
  Änderung meldet

### 2.4.25 (2026-09-17)

* **Ein Außensensor verschwindet nicht mehr, wenn der dSS keinen Wert für ihn meldet.** Der dSS lässt einen
  veraltet gewordenen Wert aus seiner Antwort fallen – ein Außenhelligkeitssensor sendet im Dunkeln nicht mehr –,
  und das Objekt wurde dann gar nicht angelegt. Ein Sensor, den ioBroker schon kennt, behält jetzt sein Objekt
  und seinen letzten Wert
* **Der Apartment-Zustand `heating_water_system` behält den Wortlaut des dSS.** Eine echte Anlage antwortet
  „hot water“, und als Boolean wurde jedes Wort außer „inactive“ zu wahr – die Betriebsart ging verloren. Ein
  Apartment-Zustand ohne active/inactive-Paar wird außerdem nicht mehr an den dSS geschrieben

### 2.4.24 (2026-09-17)

* **Schnell aufeinanderfolgende Befehle behalten ihre Reihenfolge.** Ein wartender Befehl wurde mit einem
  gleichen älteren zusammengefasst, auch wenn dazwischen ein anderer Befehl eingereiht war: an, aus, an endete
  aus, und eine Helligkeit, die während des Ausschaltens gesetzt wurde, konnte verloren gehen. Der
  zusammengefasste Befehl wandert jetzt ans Ende der Warteschlange – der zuletzt gewünschte Zustand gewinnt,
  gleiche Befehle gehen weiterhin nur einmal an den dSS
* **Ein fortlaufend geänderter Wert schiebt nicht mehr alles auf.** Jeder neue Wert startete die
  500-ms-Wartezeit neu, sodass beim Ziehen eines Reglers gar nichts gesendet wurde – und ein Befehl für ein
  anderes Gerät desselben Stromkreises wartete genauso lange. Die Wartezeit ist jetzt begrenzt: Die
  Warteschlange sendet während der Änderungen weiter, mit unverändertem Mindestabstand zwischen zwei Anfragen
* **Der Benachrichtigungskanal kommt nach einer fehlgeschlagenen Anmeldung zurück.** Schlug die
  Session-Anmeldung während eines Verbindungsversuchs des Smart-Home-WebSockets fehl, folgte bis zum Neustart
  des Adapters kein weiterer Versuch. Die Anmeldung gehört jetzt zur Wiederholung, und ein Stopp während der
  Anmeldung öffnet danach keine Verbindung mehr

### 2.4.23 (2026-09-17)

* **Die Objekt-Warngrenze lässt sich im Reiter „Einstellungen" ansehen und ändern.** Instanzen, die entstanden
  sind, bevor dieser Adapter 10000 vorgab, stehen oft noch auf 5000 – dann warnt ioBroker bei jedem Start. Die
  Karte zeigt die wirklich eingestellte Grenze, den Adapter-Standard und den Datenpunkt, erklärt, was die
  Grenze bewirkt und was nicht, und speichert einen neuen Wert mit dem normalen „Speichern" – ohne die Instanz
  neu zu starten. Die neue Grenze gilt ab dem nächsten Start
* **Schließen mit ungespeicherten Änderungen fragt nur noch einmal nach.** Bisher fragten erst der Dialog und
  danach Admin „Verwerfen?"

### 2.4.22 (2026-09-01)

* **Der Adapter hört schon zu, während er noch aufbaut.** 149,7 Sekunden lang kam nach dem
  Start nichts in ioBroker an — jeder Tastendruck, jeder Fensterkontakt und jeder Sensorwert
  zwischen „starting" und dem aktiven Abonnement war endgültig weg. Fast nichts davon war
  Warten auf den dSS: Der klassische Strukturlesevorgang war 2,6 Sekunden nach dem Start
  beantwortet, die restlichen 147 s sind Auswerten und das Anlegen von 5231 Objekten. Das
  Abonnement steht jetzt ganz vorn, und die Pegelwerte, die während des Objektaufbaus
  eintreffen, werden danach angewendet — auf die Startaufnahme obendrauf und nie davor, denn
  die Aufnahme ist das ältere Bild. Tastendrücke und Szenenaufrufe werden bewusst NICHT
  nachgeholt: Auf einen zwei Minuten alten Druck zu reagieren ist schlimmer, als ihn zu
  verlieren, und die Szenen werden am Ende des Starts ohnehin neu gelesen. Die fünf Zonen-Reads
  des Aufbaus saßen außerdem im 10-s-Raster fest — allein das waren 50,6 s Warten auf
  eine leere Warteschlange
* **Eine Abfrage behauptet keinen Wert mehr, der sich nicht bewegt hat.** 7661 von 11015
  State-Schreibungen eines Drei-Stunden-Logs trugen den Wert, der schon dastand — 69,6 %,
  und 197 der 316 State-IDs hatten über den ganzen Lauf genau EINEN Wert. Der
  Fünf-Minuten-Abgleich schrieb jedes Mal ~151 Ausgangswerte neu und änderte in drei Stunden
  einen davon; die Zonen-Temperatur-States wurden nach jedem Abgleich neu geschrieben, 875
  von 885 identisch. Verglichen wird nur auf den Abfrage- und Abgleichpfaden: Ein Ereignis
  wird weiter veröffentlicht, auch wenn die Zahl gleich bleibt — „der dSS meldet das jetzt"
  ist eine eigene Nachricht — und die Quittung eines Befehls erst recht, die muss ankommen.
  Was in einem State steht, wird aus beiden Richtungen mitgeführt, damit ein von einem
  anderen Adapter geschriebener Wert weiterhin korrigiert wird
* **Ein Stopp lässt wieder los.** `scenes.Stop` ging beim ersten Druck auf true und blieb
  true: Der dSS schickt den callScene und nie den undoScene, der ihn lösen würde — sechs
  davon in drei Stunden, kein einziges Gegenstück — eine Regel darauf feuerte also genau
  einmal. Stopp, Increment, Decrement, Area Stepping Continue und Impuls werden nach einer
  halben Sekunde freigegeben, und eine Wiederholung spannt das neu, statt eine zweite Flanke
  zu erzeugen: Ein Wandtaster wiederholt seinen Stopp (gemessen dreimal in 481 ms, ohne dass
  sich der Rollladen bewegte). Ein Rollladen auf Maximum behält seinen Zustand — er IST
  dort — und die Szenen der Temperaturregelgruppe, wo dieselben Nummern dauerhafte
  Betriebsarten bedeuten, bleiben unangetastet. `scenes.sceneId` beantwortet weiterhin,
  welche Szene zuletzt gerufen wurde
* **Ein gedrückter Taster lässt wieder los.** `<Gerät>.<n>.button` hatte genau das Problem
  der momentanen Szenen, am State direkt daneben: Der dSS meldet einen Druck und nimmt ihn nie
  zurück, der State blieb also vom ersten Druck bis zum Laufende auf true und eine Regel darauf
  feuerte genau einmal. Er wird jetzt nach einer halben Sekunde freigegeben, aus beiden Pfaden,
  die ihn setzen — dem Tasten-Ereignis und dem Szenenaufruf, den ein Wandtaster erzeugt.
  `buttonClickType` und `buttonHoldCount` behalten ihre Werte, sie beschreiben den Druck, nicht
  den Moment
* **Fünf Wohnungs-States tragen endlich einen Wert.** `daylight`, `daynight`,
  `daynight_indoors`, `twilight` und `holiday` entstanden leer und blieben leer, weil der Adapter
  nur das Wort las, mit dem ein State sich selbst beschreibt. Diese fünf schickt der dSS mit
  rohem Wert und ganz ohne Wort — gemessen: `{"name":"daylight","value":true,
  "script_id":"solar_computer"}` — es gab also nichts zu lesen. Beide Formen werden jetzt
  genommen, und die Umwandlung kommt mit einem Boolean ebenso zurecht wie mit „off"
* **Ein vDC-Read zählt als Read und darf wiederholt werden.** Der Status-Tab zeigte „classic"
  neben 0 Ausgangs-Reads, während 136 davon für vier Sonos-Player liefen: Der benannte
  Kanal-Lesebefehl heißt `getOutputChannelValue2` und passte auf keinen Zähler. Derselbe Read
  fehlte in den wiederholbaren Anfragen, obwohl er für einen Sonos-Player der EINZIGE Weg zu
  Lautstärke und Ein-Zustand ist
* **Sechs Geräte heißen nicht mehr „(undefined)".** `outputMode 64` ist eine
  Heizungsventil-Klemme und fehlte in der Karte. Ein unbekannter Modus erreicht den
  Objektnamen jetzt gar nicht mehr, er wird stattdessen protokolliert. Bestandsinstallationen
  behalten ihren Namen
* **Vier Wohnungs-States sagen, was der dSS wirklich schickt.** Sie deklarierten
  „true"/„false", während der dSS „active"/„inactive" antwortet. Die Werte stimmten über den
  Ersatzweg trotzdem, aber eine Schreibung hätte das falsche Wort gesendet — und die einzige
  Zeile, die das sagte, stand auf debug und feuerte fünfmal ungesehen. Sie warnt jetzt einmal
  je State
* **Der Startbericht bittet nicht mehr um Issues für eigene Entscheidungen.** Von den 45
  States, die er als nicht zuordenbar auflistete, gehörten 42 zu Zonen und Gruppen, für die
  dieser Adapter selbst keine Objekte angelegt hat. Sie werden abgezogen, übrig bleiben die
  Namen, die wirklich niemandem gehören
* **Die Cluster-Sperren bekommen die Wörter, mit denen der dSS antwortet.** `user_lock` und
  `operation_lock` entstanden ohne Wertzuordnung, ihr Schreib-Handler konnte deshalb nur
  warnen — der Weg dahinter war nie gelaufen
* **Die stündliche Probe eines gelernten Kanals kostet nicht mehr vier Antworten.** Ein Kanal,
  den der Status nie beantwortet, wird einmal pro Stunde geprobt, damit das Gelernte nicht
  ewig festhängt — und diese Probe verbrauchte das volle Folgebudget: zwölf der
  vierundachtzig Statusabfragen eines Drei-Stunden-Laufs, geheilt hat sie nichts. Sie reitet
  jetzt auf einer einzigen Statusabfrage mit
* **Drei Zahlen bedeuteten etwas anderes, als sie aussahen.** `info.apiActivity` wies ein
  Zehn-Minuten-Fenster aus und maß neun bis zehn, 4,9 % zu wenig und immer in dieselbe
  Richtung. Der Shutdown druckte einen Long-Poll-Termin an die Stelle, an der er wie eine
  Dauer aussah, und behauptete damit 15 s für ein Beenden, das 116 ms dauerte. Und „Plan next
  queue entry" nannte den gerade fertigen Eintrag, während die Priorität in derselben Zeile
  zu dem gehörte, der eingeplant wurde

* **Einem Rollladen wird nicht mehr zuerst der geratene Szenenwert geschrieben.** Der Preset war
  der Platzhalter für eine Position, die während der Fahrt niemand kennen konnte — mit der Smart
  Home API kommt die echte rund zwei Sekunden später und folgt der Bewegung, der geratene Wert
  erzeugte also nur einen Sprung. Er trägt zudem den Wert der GRUPPEN-Szene, und die ist nicht
  immer das Ziel des einzelnen Geräts: An einer echten Anlage gemessen bekam ein Rollladen 50
  geschrieben, während er auf 60 fuhr — der falsche Wert stand 21 Sekunden. Ohne Smart Home API
  bleibt der Preset unverändert erhalten
* **Ein User-State wird nur noch dann an den dSS geschrieben, wenn sich sein Wert wirklich
  ändert.** Skripte, die ihre States alle paar Minuten neu setzen, ließen bisher jede einzelne
  Schreibung weiterreichen, auch wenn der dSS den Wert längst hatte — gemessen: 31 sinnlose
  Requests in 40 Minuten, damit der größte verbliebene Anteil der klassischen Last. Der im dSS
  bekannte Wert wird aus beiden Richtungen nachgeführt, ein im dSS geänderter State gilt also nie
  fälschlich als unverändert
* **Ein fahrender Ausgang meldet sein Ziel nicht mehr, bevor er dort ist.** Die Interpolation
  klemmte am Zielwert — war das angekündigte Fahrtende überschritten, während der dSS noch
  „moving" meldete, behauptete der State die Ankunft. An einer echten Fahrt gemessen: 2,1 Sekunden
  zu früh. In diesem Moment wird jetzt nichts geschrieben; der echte Wert folgt binnen rund zwei
  Sekunden, weil der Kanal nach dem angekündigten Ende kurz auf dem schnellen Takt bleibt (ein
  Gerät, das auf „moving" hängen bleibt, landet weiterhin im normalen Follow-up-Verfahren)

* **Ein Joker mit Ausgang folgt jetzt seinen Szenen.** Eine geschaltete Steckdose hat einen
  Ausgangswert, aber keinen eigenen Lesepfad: Er kam immer erst mit dem nächsten Abgleich — an
  einer echten Anlage gemessen erschien der Wert einer um 10:20:04 eingeschalteten Steckdose um
  10:21:02, also 57 Sekunden später. Jetzt wird er beim Start und direkt nach einem Szenenaufruf
  gelesen, über dieselbe gebündelte Statusabfrage wie bei allen anderen Gerätetypen — ein ganzer
  Raum kostet also weiterhin EINE Abfrage. Ohne Smart Home API ändert sich nichts: Ein
  Joker-Ausgang hat keinen anderen Lesepfad, dafür bleibt der Abgleich zuständig

### 2.4.21 (2026-08-31)

* **vDC-Geräte (Hue, Sonos und Co.) lesen ihre Ausgänge überhaupt zum ersten Mal.** Sie haben
  keinen eigenen Gerätepfad, im Sammelzweig blieben sie deshalb ganz ohne Read: Bei einem Kanal
  lief ein Offset-Read, den der dSS für sie nicht beantworten kann („Could not find item.
  deviceOutputIndex:255"), bei mehreren Kanälen gab es nur eine Debug-Zeile. Ihre Werte existierten
  nur dort, wo der Smart-Home-Status sie zufällig mitlieferte. Jetzt bedient sie der benannte Read
  `device/getOutputChannelValue2` - live gegen einen dSS20 1.19.13 verifiziert: Lautstärke und
  Power-State von Sonos-Playern bekommen zum ersten Mal überhaupt Werte, und die Farbwerte von
  vDC-Lampen funktionieren auch ohne Smart Home API. Eine Antwort trägt alle Kanäle eines Geräts,
  gleichzeitige Anfragen werden zu einer gebündelt. Ein Szenenaufruf frischt die Werte ebenfalls
  sofort auf: über den gebündelten Status-Request oder - ohne Smart Home API - über einen benannten
  Read für das Gerät, das die Szene direkt angesprochen hat. Native Klemmen behalten ihren
  Offset-Read (über das Struktur-Flag gefiltert), und ein dSS, der den benannten Aufruf ablehnt,
  wird je Gerät gemerkt
* **Als invalid markierte Metering-Sensoren werden beim Start einmal gelesen** (niedrige
  Priorität, ein Bus-Read je Sensor): Wirkleistung, Ausgangsstrom und Scheinleistung messender
  Klemmen. Ein Gerät mit konstantem Verbrauch - ein Drucker im Standby - sendet unter Umständen
  monatelang kein Sensor-Event, diese States blieben seit dem Anlegen ihrer Objekte leer.
  Energiezähler und High-Range-Strom haben unverifizierte native Auflösungen und bleiben bewusst
  bei den Events
* **Der Smart-Home-API-Key ist jetzt optional.** Die neue API nimmt auch die Anmeldung der
  klassischen Schnittstelle als Cookie an - an einem dSS20 1.19.13 für jeden Endpunkt gemessen,
  den dieser Adapter liest, UND für den Notification-Websocket. Ohne Key nutzt der Adapter
  einfach die Anmeldung, die er ohnehin hat; der Smart-Home-Weg braucht also keinen zweiten
  Zugang. Und ein Key, den der dSS ablehnt (widerrufen oder durch einen neueren gleichen Namens
  ersetzt), legt den Weg nicht mehr lahm: Der Adapter sagt es einmal, wechselt auf die Anmeldung
  und läuft weiter. Ein eingetragener Key bleibt der bevorzugte Weg - er ist dauerhaft und
  braucht keine Erneuerung
* **Ein Rollladen folgt seiner Fahrt jetzt live, statt am Ende zu springen.** Der Status lässt den
  Wert weg, solange ein Ausgang fährt - er trägt aber die ganze Fahrt mit: wo sie startete, wohin
  sie geht und welches Zeitfenster sie braucht. Jede Bewegung bringt ihr eigenes Fenster vom dSS
  mit, eine langsame Markise und ein schneller Rollladen sind also gleichermaßen richtig, nichts
  ist angenommen. Daraus wird die Position berechnet und während der Fahrt geschrieben, der Kanal
  bleibt für den echten Endwert offen, die nächste Abfrage steht direkt nach dem Fahrtende an
  statt im starren 15-s-Takt, und eine laufende Fahrt verbraucht das Follow-up-Budget nicht mehr
  (live gemessen an einem dSS20 1.19.13: volle Fahrt von 100 auf 0 in 24,8 s)
* **Die CIE-x/y-Farbkoordinaten kommen richtig skaliert an.** Die Kanalskala liefert sie als
  0..1, die States halten 0..10000 - seit 2.4.18 rundete der Smart-Home-Pfad jede Koordinate auf
  0 oder 1 zusammen; der neue benannte Read wendet denselben korrigierten Faktor an

### 2.4.20 (2026-08-31)

* **Der Power-Level-Alias skaliert jetzt richtig.** Der Live-Smoke-Test von 2.4.19 widerlegte die
  angenommene 0..100-Skala des `level`-Felds: eine geschaltete Steckdose mit versorgtem Gerät
  meldete `level: 1`, der `powerLevel`-State zeigte „1 %". Das Feld ist 0..1 (passend zur Struktur,
  die auch die Schaltschwelle auf 0..1 normalisiert) und wird jetzt auf den 0..100-State skaliert
  und geklemmt

### 2.4.19 (2026-08-31)

* **`info.outputApi` springt nicht mehr zwischen den beiden APIs hin und her.** Auf hybriden Anlagen
  ließen einzelne Kanäle, die der Status strukturell nie liefert (live gemessen: die Ausgänge von
  Audio-Geräten fehlen im Status komplett), den State rund eine Minute nach jedem Abgleich auf
  „classic" kippen und mit dem nächsten wieder zurück - etwa alle fünf Minuten, rund um die Uhr.
  Klassische Reads, die der Sync für solche Einzelkanäle übergibt, melden nicht mehr; „classic"
  erscheint, wenn die Statusabfrage selbst scheitert, der Smart-Home-Pfad in seiner Pause ist, die
  Option aus ist - oder einmal pro Adapterstart, wenn ein generisches Ein-Kanal-Gerät (weder
  Licht-, Beschattungs- noch Joker-Hardware) seinen Initialwert über den bewusst klassischen
  Lesepfad liefert
* **Kanäle, die der Status nie beantwortet, werden gelernt** (nach zwei verbrauchten
  Follow-up-Budgets) und gehen sofort an den klassischen Read - ihre Werte kommen ~60 s früher und
  die sinnlosen Follow-up-Statusabfragen (vier je Auslöser, je ~59 KB) entfallen. Liefert eine
  spätere Statusantwort den Kanal doch, heilt sich das Lernen von selbst
* **Zwei Id-Verwechslungen des Status werden per Alias aufgelöst**, die betroffenen Kanäle kommen
  damit doch über die Smart Home API: eine geschaltete Steckdose (SW-KL200) meldet ihr
  deklariertes `powerLevel` als `level`-Feld eines `powerState`-Outputs, und Rollläden (GR-KL300)
  melden die eine class-64-Shade-Bank nur unter den `...Outside`-Ids, obwohl sie auch die
  `...Indoor`-Kanäle deklarieren - der klassische Read hätte beiden denselben Wert geliefert. Der
  `powerLevel`-State solcher Steckdosen bekommt damit zum ersten Mal überhaupt einen Wert
* Die Hilfs-States des dSS-Fenster-Addons (`<dsuid>_open-tilded`) loggen auf debug statt info -
  der Fensterzustand selbst kommt ohnehin über Binäreingang und Geräte-State an
* **Der Status-Tab zeigt live, was jede Schnittstelle in den letzten 10 Minuten wirklich getan
  hat** (`info.apiActivity`, alle 30 s veröffentlicht): empfangene Ereignisse und gesendete Befehle
  der klassischen API, Zähler- und Status-Reads der Smart Home API und ihre Notifications - der
  Beleg, dass ein Weg wirklich arbeitet, nicht nur, dass er konfiguriert ist

### 2.4.18 (2026-08-31)

* **Die Ausgangswerte der Geräte können über die Smart Home API gelesen werden.** Mit aktivierter
  Option kommen die initialen Reads beim Start und die Nachlese nach jedem Szenenaufruf aus EINEM
  Apartment-Status-Request (~59 KB, ~100 ms für alle Geräte auf einmal) statt aus einem gedrosselten
  klassischen Read je Ausgangskanal - der Teil des Starts, der auf großen Anlagen Minuten dauern
  konnte. Der Status liefert jeden Ausgang bereits in der Skala der ioBroker-States, offline gegen
  einen echten Objektexport verifiziert: jeder vergleichbare Wert stimmt, und 132 Kanal-States, die
  der klassische Pfad nie füllen konnte (hue, colortemp, x, y der Lichter), bekommen endlich Werte
* Die aus Live-Messungen gelernten Regeln sind eingebaut: ein Ausgang, der gerade **fährt, trägt
  keinen Wert** im Status und behält seinen letzten Stand (nach 15 s erneut gefragt, höchstens
  viermal, dann hat der klassische Read das letzte Wort); eine Antwort, die schon unterwegs war,
  bedient nie einen Auslöser, der nach ihrem Abflug kam; boolesche Kanäle bleiben beim klassischen
  Read; eine gescheiterte Statusabfrage fällt sofort auf die klassischen Reads zurück und pausiert
  den Smart-Home-Pfad für fünf Minuten. Mit ausgeschalteter Option verhalten sich die Werte exakt
  wie bisher - einziger Unterschied: Requests, die nie funktionierten, werden nicht mehr gesendet
  (der colortemp-Read eines Lichts ging immer kaputt raus und erzeugte nur eine Warnung)
* **Der Client der neuen API kann nicht mehr hängen bleiben.** Eine Verbindung, die mitten im
  Antwort-Body starb, ließ den Request bislang ewig offen - kein Fehler, kein Retry. Der klassische
  Client hatte diesen Handler immer, dem neuen fehlte er. Ein falsches Passwort bei der
  Key-Erstellung zeigt jetzt die echte Antwort des dSS statt eines generischen Satzes
* **Der API-Key-Dialog benutzt das App-Token aus dem Formular.** App-Token und API-Key in einem
  Besuch anzulegen scheiterte bisher an „Bitte zuerst das App-Token erstellen oder eintragen", weil
  die Instanz nur das GESPEICHERTE Token kannte. Ein gespeicherter API-Key, der nicht nach einem
  aussieht (typisch: js-controller konnte ihn nach einem Backup-Restore nicht entschlüsseln), wird
  beim Start benannt statt als anonymer HTTP 401, und ein dSS ohne /api/v1 (HTTP 404) geht sofort
  in den maximalen Backoff und sagt es einmal, statt stündlich zu warnen
* Grundlagen-Härtung des Notification-Websockets: tote Verbindungen werden per Ping nach 30 s
  Stille erkannt und nach 90 s neu verbunden, fragmentierte Nachrichten sind in der Gesamtgröße
  begrenzt, und die Debounce-Defaults folgen der gemessenen Realität (5 s Koaleszenz, 15 s Maximum)
* **Der Notification-Websocket wird jetzt genutzt - als bewusst gedrosseltes Sicherheitsnetz.**
  Jeder Zähler-Tick feuert eine Notification ohne Nutzdaten (gemessen: 17 in 75 Sekunden), während
  Taster und Szenen von den klassischen Events bereits präzise gemeldet werden. Eine Notification
  stößt deshalb höchstens alle fünf Minuten einen Abgleich aller Ausgangswerte an: das fängt, was
  an ioBroker vorbei passiert - eine Fremd-App, die einen Ausgang direkt schreibt - ohne
  Dauerlast. Der Kanal verbindet sich selbst neu, ein dSS ohne ihn ändert nichts
* **Jede Statusantwort aktualisiert auch die Raumtemperaturregelung jeder Zone** - Sollwert und
  Stellgröße, grad- und prozentgenau gegen eine echte Anlage verifiziert; die Betriebsmodi bleiben
  beim klassischen Pfad. Und die in digitalSTROM vergebenen Szenennamen werden einmalig aus der
  neuen API geladen, um die Lücken der klassischen Benennung zu füllen
* **Die Einstellungen erklären den Hybrid-Ansatz und zeigen ihn bei der Arbeit.** Der
  Verbindungs-Tab führt durch drei nummerierte Schritte - Serveradresse (einmal eingetragen,
  bedient beide Schnittstellen), das App-Token als Basiszugang in natürlicher Reihenfolge
  (Anmeldedaten zuerst, das erstellte Token landet darunter) und der Smart-Home-API-Key als
  Beschleuniger - am PC nebeneinander. Ein neuer Status-Tab zeigt die Arbeitsteilung live: welche
  Schnittstelle gerade Ereignisse, Zählerwerte und Ausgangswerte liefert, gestützt auf den neuen
  State `info.outputApi`, das Gegenstück zu `info.meteringApi`

### 2.4.15 (2026-08-30)

* **Der Dialog scrollt jetzt selbst.** Er benutzte `minHeight: 100%` und verließ sich darauf, dass der
  umgebende Rahmen das Scrollen übernimmt. Wo dieser Rahmen nicht scrollt, war alles unterhalb der
  ersten Bildschirmhöhe unerreichbar und der unterste Knopf blieb unter der Speicherleiste - deshalb
  half auch mehr Abstand in 2.4.12 und 2.4.14 nichts. Mit `height: 100vh` und eigenem `overflow-y` ist
  der Inhalt in beiden Fällen erreichbar; gegen einen bewusst nicht scrollenden Rahmen geprüft, 71 px
  Luft unter dem letzten Knopf

### 2.4.14 (2026-08-30)

* **Die Zählerwerte können optional über die neue Smart Home API gelesen werden.** Ein Request für alle
  Klemmen statt zwei je Klemme - an einem dSS 1.19.13 mit sechs Klemmen gemessen: aus 12 Requests in
  734 ms wird einer in 114 ms, die Grundlast des Adapters sinkt damit von rund 8,7 auf rund 2,1
  Requests pro Minute
* Der Schalter ist **standardmäßig aus**, und jeder Fehlschlag fällt auf die klassische API zurück -
  bis er eingeschaltet wird, ändert sich also nichts. Der API-Key entsteht aus dem VORHANDENEN
  App-Token, ein Passwort ist dafür nicht nötig
* Werte und States bleiben identisch. Beide APIs wurden vorher gegeneinander verglichen: fünf von sechs
  Klemmen stimmten auf die Wattsekunde überein, die sechste wich um genau den Zeitversatz zwischen den
  Abfragen ab. Die Einheit sind Wattsekunden, die Umrechnung `Wert / 3600 / 1000` bleibt deshalb
  unverändert - die API deklariert `Wh`, was nachweislich falsch ist und um den Faktor 3600 danebenläge

### 2.4.13 (2026-08-30)

* **Ein Long-Poll statt neun.** `subscribeEvents()` gab jedem Eventnamen eine eigene
  subscriptionID, es standen also neun `event/get`-Long-Polls gleichzeitig offen, jeder davon
  alle 40 Sekunden neu aufgebaut. Der DSS erlaubt viele Eventnamen auf EINER subscriptionID -
  so machen es openHAB und die Home-Assistant-Integrationen - und beantwortet sie alle über ein
  einziges `event/get`. Alle Events teilen sich jetzt die ID aus der Konfiguration
  (Standard 42). Das nimmt dem DSS die größte Grundlast des Adapters, an den Events selbst
  ändert sich nichts
* Zwei Konsequenzen daraus: Ein Neuanmelden nach einem fehlgeschlagenen Poll registriert
  **alle** Namen des Kanals erneut, denn der DSS verliert die ganze subscriptionID und nicht
  nur den einen Namen, dessen Poll gescheitert ist; und der Poll startet erst nach der letzten
  Anmeldung, damit kein Event verlorengeht, während eine Anmeldung noch unterwegs ist. Das
  Abmelden am Ende ist ein Request statt neun
* Der unterste Knopf eines Reiters brauchte mehr Platz unter der Speicherleiste des Admin, als
  2.4.12 ihm gelassen hat. Die Entwurfsvorschau (`npm run dev:admin`, `preview.html`) zeigt die
  Leiste jetzt nach, damit sich der Abstand ohne Admin prüfen lässt
* Neu: `scripts/probe-smarthome-api.js` liest einen DSS über die neue Smart Home API
  (`/api/v1` samt Notification-Websocket) aus und legt alle Antworten in einem Verzeichnis ab.
  Das ist die Grundlage für die Entscheidung, ob der Adapter auf diese API umziehen kann

### 2.4.12 (2026-08-30)

* **Der App-Token wurde doppelt entschlüsselt.** Er stand in der Option `encryptedFields` von
  `GenericApp` und gleichzeitig in `encryptedNative` der io-package.json - und `onPrepareLoad`
  entschlüsselt die eigene Liste zusätzlich zu den Feldern aus `encryptedNative`. Zweimaliges
  Entschlüsseln ergibt wieder den verschlüsselten Text, der Dialog hätte also einen
  unbrauchbaren Wert angezeigt, und ein Speichern von dort hätte einen Token hinterlegt, mit
  dem der Adapter nichts anfangen kann. Maßgeblich ist jetzt allein `encryptedNative`, und ein
  Test stellt sicher, dass das Feld nicht wieder an beiden Stellen steht
* Der unterste Knopf eines Reiters lag direkt unter der Speicherleiste des Admin, die am
  unteren Rand fixiert ist. Der Inhalt hält jetzt Abstand davon

### 2.4.11 (2026-08-30)

* **Konfigurationsdialog ohne Verbindung behoben.** Der in 2.4.10 eingeführte React-Dialog
  meldete nur `Socket connection could not be initialized: Error: Socket library could not be
  loaded!` und blieb leer. `@iobroker/socket-client` bringt socket.io nicht mit, sondern
  erwartet, dass die Seite es als globale Variable geladen hat - der Admin liefert es unter
  `/lib/js/socket.io.js` aus. Die Seite lädt es jetzt und stellt `registerSocketOnLoad` bereit,
  damit dem Client der Zeitpunkt gemeldet wird, statt dass er darauf pollt. Ein Test prüft
  beides, denn ohne sie ist der Dialog unbrauchbar und sonst fällt es niemandem auf

### 2.4.10 (2026-08-30)

* **Die Konfigurationsoberfläche ist jetzt eine eigene React-Anwendung.** jsonConfig beschreibt
  ein Formular, es gestaltet keines - Überschriften wurden als vollbreite Balken in der
  Primärfarbe des Admin-Themes gezeichnet, und die dafür gesetzten Farben erreichten immer nur
  den Text. Der Dialog ist nun direkt geschrieben: helle Fläche unabhängig vom Admin-Theme,
  abgesetzte Karten je Thema, Kopfbereich mit Adaptersymbol und Reiter mit Symbolen. Der
  App-Token lässt sich aufdecken und zeigt an, ob er gespeichert ist. Die Quellen liegen in
  `src-admin`, das Ergebnis in `admin` und wird mitversioniert, da der Adapter direkt aus
  diesem Repository installiert wird. Alle elf Sprachen wurden aus der bisherigen
  `admin/jsonConfig.json` übernommen, nichts wurde neu übersetzt. `npm run build:admin` baut,
  `npm run dev:admin` liefert `preview.html` zum Ansehen des Layouts, und der Workflow baut das
  Bündel nach und schlägt fehl, wenn es vom eingecheckten abweicht
* Damit entfällt auch eine ganze Fehlerklasse: Die Anmeldedaten für die Token-Erstellung liefen
  bisher durch ein JavaScript-Template in `jsonData`, wo ein Anführungszeichen im Passwort die
  Nachricht zerbrechen konnte. Sie werden jetzt als gewöhnliches Objekt übergeben. Die 43
  Tests, die jsonConfig und diese Maskierung absicherten, sind entfallen, 6 neue prüfen die
  gebaute Oberfläche, die Übereinstimmung der elf Sprachdateien und dass jeder vom Dialog
  angeforderte Text existiert
* **Binäreingänge benennen ihre Werte.** Der Zustand enthielt die nackte Zahl des DSS, ein
  Fenstergriff zeigte also 1, 2 oder 3, ohne dass irgendwo stand, was das bedeutet. An einem
  EnOcean-Fenstergriff (F6-10-00) beobachtet und jede Stellung einzeln gegen den lesbaren
  Gerätezustand desselben Griffs geprüft: geschlossen 1, offen 2, gekippt 3. Jeder andere
  Binäreingang behält zwei Werte, 1 inaktiv und 2 aktiv. Der Typ bleibt `number`, damit
  vorhandene Verlaufsdaten vergleichbar bleiben
* Aktualisierte Abhängigkeiten: `@apollon/iobroker-tools` 0.3.0, `actions/checkout` 7,
  `actions/setup-node` 7, `@types/node` 26, `@types/sinon` 22, `@types/proxyquire` 1.3.31,
  `@alcalzone/release-script-plugin-license` 5.2.2. chai 6, sinon-chai 4, chai-as-promised 8
  und TypeScript 7 wurden bewusst nicht übernommen: Die chai-Familie ist reines ESM, was die
  Typprüfung eines CommonJS-Projekts ablehnt, und `@typescript-eslint` bindet TypeScript auf
  unter 6.1

### 2.4.9 (2026-08-30)

* **Ungültige Admin-Konfiguration behoben.** Die beiden Trennlinien des in 2.4.5 eingeführten
  Layouts trugen eine Farbe aus der digitalSTROM-Palette, das Schema erlaubt für diese
  Eigenschaft aber nur `primary` und `secondary`. Admin wies die gesamte Konfiguration mit
  `digitalstrom has an invalid jsonConfig` zurück und fiel auf einen generischen Dialog zurück.
  Die Farbe steht jetzt in `style`/`darkStyle`, wo eine freie Farbe zulässig ist. Zwei neue
  Tests prüfen die enum-beschränkten Eigenschaften des Schemas, damit diese Fehlerklasse nicht
  unbemerkt zurückkommen kann.
* Der Release-Workflow dieses Forks versucht nicht mehr, auf npm zu veröffentlichen — der
  Paketname gehört dem Ursprungsprojekt. Ein gepushter Tag `v<Version>` erzeugt jetzt nur noch
  das GitHub-Release, dessen Text aus der Nachricht des annotierten Tags stammt.

### 2.4.8 (2026-08-30)

* Der Hinweis zur App-Token-Migration wurde aus dem Admin-Dialog und aus dem Readme entfernt.
  Keine veröffentlichte Version enthielt die falsch platzierte `encryptedNative`-Deklaration —
  ein dauerhafter Hinweis auf eine Migration, die niemand durchführen muss, würde nur verwirren.
  Der Adapter erkennt weiterhin einen Token, den er nicht zurücklesen kann, und meldet das im
  Log, jetzt ohne Bezug auf eine Versionshistorie.

### 2.4.7 (2026-08-30)

* **Das Datenabfrageintervall steht standardmäßig auf 100 s statt 60 s.** An einer produktiven
  Anlage mit 6 Zählerklemmen gemessen: Ein Zyklus liest zwei Werte je Klemme (`getConsumption` +
  `getEnergyMeterValue`), und der Timer für den nächsten Zyklus startet erst, wenn beide
  beantwortet sind — ein Zyklus dauert dadurch rund 20 s länger als das eingestellte Intervall.
  Mit 60 s ergab das gemessene 1,53 Anfragen pro Minute und Klemme, also das Anderthalbfache
  dessen, was die digitalSTROM-Regeln 8/9 erlauben. 100 s ergibt einen Zyklus von etwa 120 s und
  damit genau 1,0. Die Aussage aus 2.4.4, 60 s halte diese Regeln ein, zählte nur einen Read pro
  Zyklus und war falsch. Das Minimum bleibt bei 60 s: Kleinere Werte sind weiterhin möglich, sie
  werden jetzt nur ehrlich als Überschreitung dokumentiert statt als regelkonform bezeichnet.

### 2.4.6 (2026-08-30)

Entstanden aus dem Objekt-Export und dem Debug-Log einer produktiven Installation.

* **Raumtemperaturregelung.** Jeder Raum, den das DSS wirklich regelt, bekommt einen Kanal
  `temperatureControl` mit `ControlMode` (Art des Reglers), `ControlState` (wer den Sollwert
  besitzt) und `OperationMode` — einer lesbaren, schaltbaren Entsprechung der Szenen von
  Gruppe 48, die jedem Szenenaufruf folgt. Räume mit `ControlMode: 0` bleiben bewusst ohne
  diese Objekte, damit auf einen Blick erkennbar ist, welche Räume überhaupt geregelt werden.
* **Sollwerte je Betriebsart.** Sie werden über `zone/getTemperatureControlValues` gelesen und
  über `zone/setTemperatureControlValues` geschrieben. Die Feldnamen kommen aus der Antwort
  statt fest im Code zu stehen, und die States entstehen nur, wenn das DSS wirklich
  geantwortet hat — eine Firmware ohne diesen Endpunkt bekommt keine toten Objekte.
* `NominalValue` bleibt beschreibbar, wirkt aber nur bei externer Regelung
  (`ControlState` = extern). Beim internen Regler überschreibt das DSS den eingespeisten Wert
  — dafür sind `OperationMode` und die Sollwerte da.
* **Cluster-States.** `cluster.<id>.user_lock` und `cluster.<id>.operation_lock` hatten
  überhaupt kein Objekt, obwohl der Gruppenordner des Clusters existiert. Sie werden jetzt
  unterhalb von `apartment.groups.<id>.states` angelegt.
* **Gruppen-States mit Punkt im Namen.** `status.malfunction` und `status.service` der
  Lüftungsgruppen wurden von einem Muster verworfen, das nur ein Segment erlaubte. Sie
  entstehen jetzt als verschachtelte States, inklusive des Kanals dazwischen.
* Die Prüfung auf Räume ohne Etage wertete `isValid` als reine Truthiness aus. Ein echtes DSS
  sendet dieses Flag bei Zonen gar nicht, wodurch die Prüfung vollständig stumm war. Jetzt wird
  nur noch eine Zone übersprungen, die das DSS ausdrücklich als ungültig oder als nicht
  vorhanden meldet (`isPresent: false`, z. B. die dS-Zone 65534 für nicht zugeordnete Geräte).

### 2.4.5 (2026-08-30)

* Admin-Konfiguration neu gestaltet. Die Optionen liegen jetzt in den Reitern **Verbindung**,
  **Einstellungen** und **Hinweise** statt auf einer langen Seite — mit Abschnittsüberschriften,
  Hinweisboxen und Schalterkarten in den digitalSTROM-Farben (`#00662E` / `#7FC241`, aus dem Logo
  entnommen).
* Der neue Reiter **Hinweise** erklärt die Zertifikatsprüfung.
* Keine Option wurde umbenannt oder entfernt — bestehende Instanzeinstellungen werden unverändert
  übernommen. Ein Test prüft jetzt, dass jede Option aus `native` weiterhin ein Bedienelement hat.

### 2.4.4 (2026-08-14)

Gefunden durch eine systematische Multi-Agenten-Prüfung des gesamten Adapters. Alle diese Defekte
existierten bereits in 2.4.2 und früher — sie schlagen still fehl, deshalb sind sie nie als Fehler
aufgefallen.

* **Eine Szene für einen ganzen Raum erreichte die Geräte-Handler nie.** `zoneDevices` ist nur nach
  den echten Gerätegruppen (1, 2, 8 …) indiziert, nie nach der Broadcast-Gruppe 0 — der Fan-out
  fand also nichts, und die anschließende Weiterleitungsschleife ist als „forwarded" markiert, was
  ihn ebenfalls abschaltet. Folge: Nach jedem „Raum aus" behielten `brightness`,
  `shadePositionOutside` und `shadeOpeningAngle*` ihren alten Wert, bis zufällig eine Gruppenszene
  dasselbe Gerät traf oder der Adapter neu startete — ohne eine einzige Logmeldung. Der Adapter
  löst diesen Fall selbst aus: Seine eigenen Raum-Szenen-States senden `zone/callScene` ohne
  groupID.
* **Der App-Token wird jetzt wirklich verschlüsselt gespeichert.** `encryptedNative` und
  `protectedNative` standen innerhalb von `common` statt in der Wurzel der io-package.json, wo
  `ioBroker.AdapterObject` sie erwartet. Beides war damit wirkungslos: Der Token lag im Klartext in
  der Objektdatenbank, war für jeden anderen Adapter lesbar und stand unverschlüsselt in jedem
  Backup. **Migration:** Ein von einer älteren Version gespeicherter Token lässt sich nicht
  entschlüsseln und kommt als Müll zurück. Öffne einmal die Adapter-Konfiguration, trage den
  App-Token erneut ein (oder erstelle mit deinen DSS-Anmeldedaten einen neuen) und speichere. Der
  Adapter erkennt diesen Fall jetzt und sagt genau das, statt nur einen fehlgeschlagenen Login zu
  melden.
* **Bei manchen Geräten wurde jeder Druck auf den ersten Taster verworfen.** Der State von Taster 0
  entstand nur bei `buttonActiveGroup` 1..8, während Klicktyp und Haltedauer desselben Tasters
  immer angelegt wurden — und der Event-Handler bricht ab, wenn der einfache Taster-State fehlt.
  Bei einem Tastenfeld mit nicht zugewiesenem Taster, auf Broadcast oder in einer Gruppe über 8
  funktionierten die Taster 2..n, während Taster 1 nur `INVALID Button click` erzeugte.
* Klicktyp und Haltedauer wurden als DSS-Rohstring in einen als Zahl deklarierten State
  geschrieben — js-controller warnte bei jedem Tastendruck und die `states`-Zuordnung griff nicht.
* `EXTRANOUS ZONE found <id>` wurde bei jedem Adapterstart für jeden regulären Raum geloggt: Die
  Prüfung lief synchron, während die Räume über `setImmediate` verarbeitet werden — ihre
  Buchführung war zu dem Zeitpunkt noch leer.
* **„Geräte-Ausgangswerte aktiv abfragen" = aus unterdrückte auch die Szenen-Preset-Werte.** Die
  Option steuert laut Dokumentation nur die Lesezugriffe; die Preset-Werte gehören zu
  „Szenen-Preset-Werte verwenden". Der Gate saß vor dem Geräte-Handler statt vor dem Lesezugriff.
* Der Ausgangskanal `shadePositionIndoor` hieß „Shade Position **Outside** (curtains)". Bestehende
  Objekte behalten ihren alten Namen — ioBroker bewahrt den Namen bei Updates.

### 2.4.3 (2026-08-12)

**Laufzeitfehler**

* Die Event-Wiederherstellung konnte dauerhaft hängen bleiben: Ein erfolgreiches `event/subscribe`
  setzte den Fehlerzähler zurück, sodass ein DSS, der das Abonnement annahm, aber jedes `event/get`
  mit HTTP 500 beantwortete, den Grenzwert nie erreichte. Der Adapter blieb grün und abonnierte alle
  zwei Sekunden neu, ohne je wieder ein Event zu verarbeiten. Der Zähler wird jetzt nur noch von einem
  tatsächlich erfolgreichen `event/get` gelöscht, der Backoff wächst, und der vorgesehene
  `eventError`-/Neustart-Weg wird zuverlässig erreicht.
* Der Stop ist jetzt eine echte Barriere: Asynchrone Startup-Callbacks, die während oder nach dem
  Entladen fertig werden, erzeugen keine Timer, Requests, State-Subscriptions und kein
  `connected = true` mehr. `DSS.requestAsync()` und `httpRequest()` lehnen nach `stop()` jede Anfrage
  ab, und ein noch laufender App-Token-Dialog wird beim Entladen verfolgt und geschlossen (keine
  verspäteten `sendTo`-Aufrufe und keine späten Logmeldungen aus diesem Ablauf).
* **Geräte-Ausgangswerte aktiv abfragen = aus** deaktivierte die gesamte Jalousiesteuerung: Erkennung
  von Position und Winkel, die Schreibhandler und das Initial-Lesen lagen in einem gemeinsamen Block,
  sodass bei ausgeschalteter Option überhaupt kein Schreibbefehl mehr am DSS ankam. Das Schreiben ist
  jetzt unabhängig von der Option, die nur noch steuert, ob Ausgangswerte *gelesen* werden (initial
  und nach Szenenereignissen, für Jalousien wie für Licht).
* Szene 22 und Szene 25 hießen beide „Preset 24" und teilten sich dadurch eine State-ID. Der
  verbleibende Handler steuerte Szene 25, Szene 22 war nicht erreichbar. Szene 22 heißt wieder
  „Preset 14" (wie es der Kommentar im Code bereits sagte), und ein Test prüft jetzt alle erzeugten
  Szenen-State-IDs auf Eindeutigkeit.
* Das Queue-Coalescing ist re-entrant: Der Queue-Eintrag wird ersetzt, *bevor* die Superseded-Callbacks
  laufen. Ein Wert, der synchron aus einem Superseded-Callback eingereiht wird (typisch für einen
  weiterbewegten Schieberegler), wird nicht mehr vom älteren Aufruf überschrieben. Garantiert ist:
  Der neueste Wert wird genau einmal gesendet, ein ersetzter Wert wird nie gesendet, jeder Callback
  wird genau einmal beendet, kein Callback geht verloren.
* Ein ersetzter Schreibvorgang wird nicht mehr als Warnung gemeldet. Die Meldung
  `Error while set State for apartment-user: SupersededError: … was superseded by a newer value` war
  normales Last-write-wins-Coalescing und kein DSS-Fehler. Erwartete Queue-Abbrüche werden jetzt
  zentral klassifiziert (`DSSQueue.isExpectedQueueError`) und für alle Consumer (apartment,
  apartment-user, circuit, device/output, zone, group) nur noch als Debug protokolliert. Echte
  Netzwerk-, DSS- und Antwortfehler erzeugen weiterhin eine Warnung.
* Beim Start konnten Events verloren gehen: Die Handler wurden erst registriert, nachdem *alle*
  Subscriptions abgeschlossen waren, während jede einzelne Subscription sofort nach ihrem Erfolg zu
  pollen beginnt. Die Handler werden jetzt registriert, bevor der erste Poll etwas ausliefern kann
  (und niemals doppelt). Zusätzlich entfiel die künstliche Wartezeit von zwei Sekunden vor dem
  Abonnieren, und sobald die Subscription aktiv ist, werden die zuletzt aufgerufenen Szenen einmal mit
  niedrigster Priorität abgeglichen, sodass Szenenaufrufe während eines langen Starts nachträglich
  angewendet werden.

**Weitere Fehlerbehebungen**

* Die booleschen Ausgangskanäle `airLouverAuto` (Schwenkmodus der Lüftung) und `airFlowAuto`
  (automatische Lüftungsintensität) akzeptierten nur Zahlen und wiesen `true`/`false` zurück. Sie sind
  wieder schaltbar und werden als 0/1 an den DSS gesendet. Ungültige Typen werden weiterhin
  kontrolliert abgelehnt.
* Der Ventilationsstatus der Wohnung (Sensor 60) wurde als Boolean angelegt, wodurch jeder Statuscode
  ungleich 0 zu `true` wurde. Er ist wieder ein numerischer State und behält alle DSS-Statuscodes
  (0 = OK, 2 = Störung, 4 = Service, 6 = Störung + Service).
* Heizungs- und Ventilationsgruppen aktivierten beim Start den generischen Szenen-State (z. B.
  `Preset0`), während jedes Event den speziellen (z. B. `HeatingOff`) umschaltete. Der Initialzustand
  wird jetzt über die State-Map aufgelöst, genau wie in der Eventverarbeitung.
* Apartment-spezifische Clusternamen lecken nicht mehr zwischen Adapterinstanzen: Jede Struktur erhält
  eine eigene Kopie der Gruppentyp-Tabelle, und die Modulkonstanten werden zur Laufzeit nie verändert.
* Host-Normalisierung: Ein explizit konfigurierter Standardport wurde durch den DSS-Standardport 8080
  ersetzt, wenn der Host mit einem Schrägstrich endete (`https://dss.local:443/` wurde zu
  `https://dss.local:8080`, ebenso bei `http://…:80/` und IPv6). Behoben für Hostnamen, IPv4 und IPv6,
  mit und ohne abschließenden Schrägstrich.
* Ein vom Adapter selbst erzeugter Request-Timeout trägt jetzt eine strukturierte Kennzeichnung
  (`code: 'ETIMEDOUT'`), sodass der Retry-Klassifikator ihn erkennt und ein sicherer Lesezugriff einmal
  wiederholt wird. Schreibzugriffe werden weiterhin nie wiederholt.
* `apartment/getReachableGroups` (ein reiner Lesezugriff beim Start) darf nach einem Verbindungsfehler
  einmal wiederholt werden.

**Konfiguration und Wartung**

* Das minimale Datenabfrageintervall beträgt jetzt 60 s statt 10 s. Die digitalSTROM-Regeln 8 und 9
  erlauben höchstens einen zyklischen Lesezugriff pro Minute und Klemme, und ein Zyklus erzeugt bereits
  mehrere Messwert-Reads pro Klemme. Konfigurierte Werte zwischen 1 und 59 werden auf 60 s angehoben,
  `0` deaktiviert die Abfrage weiterhin vollständig. **Wenn du einen Wert unter 60 s eingestellt hast,
  ändert sich mit diesem Update das tatsächliche Intervall.**
* Der App-Token wird im Admin-Dialog nicht mehr im Klartext angezeigt (gespeichert war er bereits
  verschlüsselt und geschützt).
* CodeQL von der nicht mehr unterstützten Version v2 auf v4 aktualisiert.
* Node.js 22 ist die neue Mindestversion (Node 20 hat das Supportende erreicht), CI und Release laufen
  auf Node 22 und 24.
* Der Dependabot-Auto-Merge-Workflow wurde gehärtet: Er checkt keinen Pull-Request-Code mehr aus, läuft
  nur für Pull Requests, die wirklich von Dependabot stammen, verwendet das automatisch
  bereitgestellte `GITHUB_TOKEN` mit minimalen Rechten statt eines persönlichen Access Tokens und
  pinnt die offizielle Action `dependabot/fetch-metadata` auf eine vollständige Commit-SHA. Gemergt
  wird jetzt über GitHub-Auto-Merge, erforderliche Prüfungen müssen also zuerst bestehen. Die Policy
  wurde strenger: Produktionsabhängigkeiten nur noch bei Patch-Updates, Entwicklungsabhängigkeiten bei
  Patch- und Minor-Updates.
* Das gesamte Projekt ist jetzt frei von Typfehlern: `npm run typecheck` (`tsc --noEmit` mit `strict` und
  `checkJs`) läuft in der CI und muss grün bleiben. Alle Typen sind über JSDoc deklariert — ohne
  Unterdrückungen und ohne abgeschwächte Compiler-Optionen.
* DSS-States, die zu keinem Gerät, keiner Klemme, keinem Raum, keiner Gruppe und nicht zur Wohnung
  gehören, werden einmalig mit ihrem genauen Namen gemeldet, statt stillschweigend gar kein Objekt zu
  bekommen.
* Aktualisierung der Entwicklungsabhängigkeiten: gar keine bekannten Schwachstellen mehr. Die Funde in
  mocha und `@iobroker/testing` sind über npm-`overrides` (serialize-javascript, diff, esbuild) behoben,
  statt die Testwerkzeuge herabzustufen.

### 2.4.2 (2026-08-02)

* Kein HTTP-Keep-Alive mehr. Der DSS schließt untätige Verbindungen, was bei der nächsten Anfrage
  sporadisch zu „socket hang up" führte.
* Fehlende `role` bei den States der Binäreingänge ergänzt.
* Boolesche States werden über die vom DSS gemeldete Wertzuordnung abgebildet; die üblichen
  Aus-Begriffe (off/inactive/no/0) werden verstanden, statt jede nichtleere Zeichenkette als `true` zu
  interpretieren.
* Vom DSS gelieferte Werte werden in den für das Objekt deklarierten Typ konvertiert. Der DSS meldet
  Zahlen als Zeichenketten, was zu Meldungen wie „has to be type number but received type string"
  führte.
* Ein **Lesezugriff** wird einmal wiederholt, wenn die Verbindung ohne Antwort geschlossen wurde
  („socket hang up"). Aktionen mit Nebenwirkungen (`callScene`, `undoScene`, `event/raise`,
  `state/set`, `pushSensorValue`, Ausgangswert-Schreibvorgänge) werden nie automatisch wiederholt.
* State-Werte werden nicht mehr geschrieben, bevor die zugehörigen Objekte existieren.
* Nicht unterstützte Ausgangskanäle werden auf Debug-/Info-Ebene protokolliert statt als Warnung.
* Eigener Verbindungspool für die Event-Long-Polls, damit normale Befehle wie ein Szenenaufruf nicht
  mehr blockiert werden können.
* Ein Gerät, das einen Ausgangswert nicht liefert (z. B. eine Jalousie ohne Lamellen), wird einmalig
  gemeldet statt nach jeder Szene erneut zu warnen.
