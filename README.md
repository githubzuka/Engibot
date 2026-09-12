# Engibot

A small, fully functional Groq chatbot with a server-side API key.

## Accounts and MongoDB

Engibot requires an account before chat. Set `MONGODB_URI` in `.env` to the MongoDB Atlas connection string, replacing `<db_password>` locally with a newly rotated database password. Set a private random `AUTH_SECRET` too. User passwords are hashed with Node's scrypt and are never stored directly.

## Run locally

1. Copy `.env.example` to `.env` and add your Groq API key as `GROQ_API_KEY`.
2. Run `npm start`.
3. Open `http://localhost:3000`.

The API key is only used by `server.js` and is never sent to the browser.

## Deploy to Vercel

This is a Node.js app. The `api/[...path].js` file is the Vercel entrypoint; do not configure the project with the Python runtime. In Vercel Project Settings, add `GROQ_API_KEY`, `MONGODB_URI`, and `AUTH_SECRET` as environment variables, then redeploy. Do not upload `.env`.

The Python OCR and Word-document features depend on local Python packages and Tesseract, so they are not available in this Node-only Vercel function without moving those features to a separate service or deploying a compatible Python function. Vercel function storage is also temporary, so generated files should use object storage for production downloads.

## Image reading

Install the Python OCR and document libraries with `pip install -r requirements.txt`. Install the Tesseract OCR application separately for image text extraction. Use the `+` button to attach images, PDFs, Word documents, spreadsheets, CSV, JSON, TXT, Markdown, XML, HTML, or log files.

When you ask Engibot to create a Word document, report, notes, or handout, it generates a formatted `.docx` file and shows a download button in the chat. The generated text is newly written from the conversation and attached file data; it is not a substitute for a third-party plagiarism database check.