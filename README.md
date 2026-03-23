# FFmpeg Processing Server

Video processing server voor de Video Production Studio. Ontvangt een screen recording + audio, vertraagt de video 2x, merget het met de audio, en geeft de final video terug.

---

## Hoe het werkt

1. Je app stuurt een POST request naar `/api/process` met de video URL en audio URL
2. De server downloadt beide bestanden
3. FFmpeg vertraagt de video (2x langer)
4. FFmpeg merget de vertraagde video met de originele 1x audio
5. De server stuurt een URL terug naar de final video

---

## Deploy op Railway (5 minuten)

### Stap 1: Maak een GitHub repository

1. Ga naar https://github.com/new
2. Naam: `ffmpeg-processing-server`
3. Klik "Create repository"
4. Upload alle bestanden uit deze map naar de repository (drag & drop op GitHub werkt)

### Stap 2: Deploy op Railway

1. Ga naar https://railway.app en log in met je GitHub account
2. Klik "New Project"
3. Klik "Deploy from GitHub Repo"
4. Selecteer je `ffmpeg-processing-server` repository
5. Railway detecteert automatisch de Dockerfile en begint met bouwen
6. Wacht tot de deploy klaar is (2-3 minuten)

### Stap 3: Maak een publieke URL

1. In je Railway project, klik op je service
2. Ga naar "Settings" → "Networking"
3. Klik "Generate Domain" — je krijgt een URL zoals `ffmpeg-processing-server-production-xxxx.up.railway.app`

### Stap 4: Plak de URL in je app

1. Ga naar je Video Production Studio app
2. Ga naar Settings → API Configuration → Processing API URL
3. Plak: `https://ffmpeg-processing-server-production-xxxx.up.railway.app/api/process`
4. Sla op

Klaar! Je app stuurt nu automatisch video's naar deze server voor processing.

---

## Testen

Je kunt de server testen door naar de root URL te gaan in je browser:
```
https://jouw-railway-url.up.railway.app
```
Je zou moeten zien: `{"status":"ok","message":"FFmpeg Processing Server is running"}`

---

## Kosten

Railway biedt $5 gratis credits per maand. Daarna betaal je ~$5-10/maand afhankelijk van hoeveel video's je verwerkt. Een enkele video kost vrijwel niks aan resources.
