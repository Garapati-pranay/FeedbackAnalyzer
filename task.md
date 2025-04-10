# Feedback Analysis System - ToDo List

- [ ] **1. Project Setup:**
    - [x] Initialize Next.js project (App Router).
    - [x] Install dependencies: `xlsx`, `ai`, `@supabase/supabase-js`.
    - [x] Set up Supabase project & create `categorized_feedback` table.
        - Columns: `id` (UUID, PK), `run_id` (UUID/TEXT), `student_identifier` (TEXT), `question_text` (TEXT), `original_answer` (TEXT), `assigned_category` (TEXT), `processed_at` (TIMESTAMPTZ, default now()).
    - [x] Configure environment variables (`.env.local`) for `GOOGLE_GENERATIVE_AI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `USE_MOCK_LLM` (optional).
- [ ] **2. API Route Structure (`/app/api/analyze/route.ts`):**
    - [x] Create the API route file (`route.ts`).
    - [ ] Implement basic POST request handler structure.
    - [x] Initialize Supabase client within the handler scope.
    - [x] Generate a unique `run_id` per request (e.g., using `crypto.randomUUID()`).
- [ ] **3. File Handling:**
    - [x] Get uploaded file buffer from the POST request (`FormData`).
    - [x] Read the buffer using `xlsx.read()`.
    - [x] Parse the relevant sheet into an array of objects using `xlsx.utils.sheet_to_json()`. Handle potential errors.

- [ ] **4. Initial Analysis: Column Mapping** (Replaces previous Section 4)
    - [x] **4.1.** Extract headers from the first data row.
    - [x] **4.2.** Construct prompt for LLM with headers, asking it to identify Student ID and Question columns.
    - [x] **4.3.** Call LLM (e.g., `generateObject`) to get the proposed mapping (e.g., `{ studentIdHeader: 'Detected Header', questionHeaders: ['QH1', 'QH2'] }`).
    - [x] **4.4.** Parse and validate the LLM's mapping response.
    - [x] **4.5.** Send the proposed mapping back to the frontend.

- [ ] **5. User Confirmation: Column Mapping** (New Section)
    - [x] **5.1.** Frontend displays the proposed mapping (Student ID, Question Columns).
    - [x] **5.2.** Frontend provides a "Confirm & Proceed" button.
    - [x] **5.3.** User clicks confirm, triggering a new request/stage (`POST /api/process`) on the backend with the `runId`, `confirmedMapping`, and `rows`.

- [ ] **6. LLM Interaction: Categorization** (Was Section 5)
    - [ ] **6.1.** Get `runId`, `confirmedMapping`, `rows` in `/api/process` route. [x] *(Basic structure done)*
    - [x] **6.2.** Initialize Vercel AI SDK (`generateText`, configured for Gemini). *(Done previously)*
    - [x] **6.3.** Implement logic to switch to a mock LLM based on `USE_MOCK_LLM` env var. *(Done previously)*
    - [ ] **6.4.** In batches of up to 5 students (using `confirmedMapping` and `rows`):
        - Extract `respondentId` using `confirmedMapping.studentIdHeader`.
        - Dynamically construct the prompt string listing actual (`confirmed`) `questionText`: `answer` pairs for the batch.
    - [ ] **6.5.** Call `generateText` or `mockAnalyzeFeedback` with the prompt within a try-catch block.

- [ ] **7. Response Parsing & Normalization** (Was Section 6)
    - [x] Parse the LLM's categorization response string (expected format: `"Question Text": category\n...`). *(Handled by generateObject)*
    - [x] Handle potential parsing errors (e.g., missing colon, empty lines). *(Handled by generateObject)*
    - [x] Create and apply a `normalizeCategory` function (e.g., trim, lowercase, replace whitespace with `_`). *(Basic implementation added)*

- [ ] **8. Database Interaction (Supabase)** (Was Section 7)
    - [x] For each successfully parsed and normalized `(questionText, assigned_category)` pair within a batch:
        - [x] Prepare the record object for insertion (`run_id`, `student_identifier` (from confirmed header), `question_text` (confirmed header), `original_answer`, `assigned_category`).
    - [x] Batch insert records for the student batch using `supabase.from('categorized_feedback').insert(...)`.
    - [x] Wrap database operations in try-catch blocks.

- [ ] **9. Aggregation & Final Response/Streaming** (Was Section 8)
    - [x] (Option 1: Simple End Response) After processing all students, query Supabase: `SELECT * FROM categorized_feedback WHERE run_id = current_run_id`.
    - [x] (Option 1: Simple End Response) Implement logic to transform the flat array from Supabase into the nested JSON output format: `{ question_text: { assigned_category: [ { student: ..., answer: ... } ] } }`.
    - [x] (Option 1: Simple End Response) Return the aggregated JSON using `NextResponse.json()`. Handle query errors.
    - [x] (Option 2: Streaming - More Complex) Implement mechanism (e.g., Server-Sent Events, WebSocket) to stream categorized results back to the frontend as they are processed. *(Implemented via SSE)*
    - [x] Calculate and stream aggregated statistics at the end.

- [ ] **10. Mock LLM Implementation** (Was Section 9)
    - [ ] Create/Update the `mockAnalyzeFeedback` function for categorization.
    - [ ] It should accept the dynamic prompt string based on confirmed headers.
    - [ ] It should parse the prompt to identify questions.
    - [ ] It should return a response string in the correct `"Question Text": category` format.
    - [ ] (Optional) Create a mock function for the *initial header mapping* LLM call.

- [ ] **11. Basic Frontend (`src/app/page.tsx`)** (Was Section 10)
    - [x] Create/Modify the main page component.
    - [x] Add a file input form (`<input type="file" accept=".xlsx, .xls">`) and submit button.
    - [x] Add client-side state (`useState`) for selected file, loading status, and API response message.
    - [x] **Update state:** Add state for proposed mapping, confirmation status, runId, rows, liveResults, statsData.
    - [x] Add JS handler for initial form submission (`handleSubmitForMapping`):
        - [x] Prevent default.
        - [x] Create `FormData` with the file (key: 'file').
        - [x] `POST` to `/api/analyze` (Stage 1: Get Mapping).
        - [x] Update state based on response (loading, **proposed mapping**, runId, rows, message/error).
    - [x] **Display Mapping:** Show the proposed mapping (Student ID, Questions) to the user.
    - [x] **Add Confirmation:** Add "Confirm & Proceed" button and its handler.
        - [x] Handler triggers Stage 2 processing (`POST /api/process` with `runId`, `confirmedMapping`, `rows`).
        - [x] Handler consumes SSE stream, updates state (`highlightedBatchIndex`, `liveResults`, `statsData`).
    - [x] **Display Results:** Display loading indicator and API response/error message.
    - [x] Display live results table, grouped by respondent.
    - [x] Display aggregated statistics in the 'complete' stage.
    - [x] Add "Analyze Another File" button in 'complete' stage.

- [ ] **12. Error Handling & Logging** (Was Section 11)
    - [ ] Review and enhance error handling throughout the new multi-stage process.
    - [ ] Add/Update `console.log` statements for progress tracking and debugging across stages. 