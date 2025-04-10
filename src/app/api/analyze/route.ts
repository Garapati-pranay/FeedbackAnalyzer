import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import * as XLSX from 'xlsx'; // Import xlsx library
import { google } from '@ai-sdk/google'; // Import Google provider
import { generateText, generateObject } from 'ai'; // Import generateText and generateObject
import { z } from 'zod';

// --- Constants --- 
const GENERATED_ID_HEADER = "__generated_row_id__"; // Constant for fallback header

// --- AI Model Initialization ---
// Initialize the Gemini model instance globally
const model = google('gemini-2.0-flash');

// Zod schema for describing a single question header
const questionHeaderSchema = z.object({
    header: z.string().describe("The exact column header text."),
    isCategorical: z.boolean().describe("Set to true if the question expects a categorical, quantitative, or limited-choice answer (e.g., number ranges, yes/no, ratings, selection from list). Set to false if it expects free-form text feedback or opinions.")
});

// Zod schema for the expected column mapping from LLM
const mappingSchema = z.object({
    // Allow null if no suitable ID found
    studentIdHeader: z.string().nullable().describe("The exact column header that uniquely identifies the respondent or source (e.g., 'Email', 'Student ID'). Return null if no clear unique identifier column is found."),
    // Array of objects describing each question header
    questionHeaders: z.array(questionHeaderSchema).describe("An array of objects, each describing a column header identified as a feedback question and whether it's categorical/quantitative (isCategorical=true) or qualitative/free-text (isCategorical=false).")
});

// --- Mock LLM Function (Placeholder) ---
// TODO: Implement fully in Step 9
async function mockAnalyzeFeedback(prompt: string): Promise<{ text: string }> {
    console.warn('Using mock LLM response!');
    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 50)); 
    // Basic mock response - replace with dynamic logic in Step 9
    return { text: '"Mock Question 1": mock_category_1\n"Mock Question 2": mock_category_2' };
}

// Function to get Supabase credentials from environment variables
function getSupabaseCredentials() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl) {
        throw new Error('Missing environment variable: SUPABASE_URL');
    }
    if (!supabaseAnonKey) {
        throw new Error('Missing environment variable: SUPABASE_ANON_KEY');
    }

    return { supabaseUrl, supabaseAnonKey };
}

export async function POST(req: NextRequest) {
    console.log('Received request in /api/analyze');
    const runId = randomUUID();
    console.log(`Generated run ID: ${runId}`);

    // --- Read Env Vars ---
    const useMockLlm = process.env.USE_MOCK_LLM === 'true';
    console.log(`Using mock LLM: ${useMockLlm}`);

    try {
        // Initialize Supabase client
        const { supabaseUrl, supabaseAnonKey } = getSupabaseCredentials();
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        console.log('Supabase client initialized.');

        // --- 3.1 Get uploaded file buffer --- 
        const formData = await req.formData();
        const file = formData.get('file') as File | null;

        if (!file) {
            return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
        }
        console.log(`Received file: ${file.name}, size: ${file.size}, type: ${file.type}`);

        // Convert file Blob to ArrayBuffer
        const fileBuffer = await file.arrayBuffer();
        console.log('File converted to ArrayBuffer.');

        // --- 3.2 Read the buffer using xlsx.read() ---
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        console.log('Workbook parsed successfully.');

        // --- 3.3 Parse sheet to JSON --- 
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) {
            return NextResponse.json({ error: 'No sheets found in the workbook.' }, { status: 400 });
        }
        const worksheet = workbook.Sheets[firstSheetName];
        let rows: any[] = XLSX.utils.sheet_to_json(worksheet);
        console.log(`Parsed ${rows.length} rows from sheet: ${firstSheetName}`);

        if (rows.length === 0) {
            return NextResponse.json({ error: 'Spreadsheet is empty or the first sheet has no data.' }, { status: 400 });
        }

        // --- Section 4 Starts Here --- 
        // 4.1 Extract headers
        let allHeaders = Object.keys(rows[0] as object);
        console.log('Initial Headers:', allHeaders);

        // 4.2 Construct LLM prompt for mapping
        const mappingPrompt = `Analyze the following spreadsheet headers. Identify:
1. The single header that most likely represents a unique identifier for the respondent/source (e.g., name, email, ID). If none found, return null for studentIdHeader.
2. All headers that represent the actual feedback questions asked.
3. For EACH feedback question header identified, determine if it expects a categorical/quantitative answer (isCategorical=true - e.g., number ranges, ratings, yes/no, selection from list) OR free-form qualitative feedback (isCategorical=false).
Ignore irrelevant metadata columns unless they are the primary identifier.
Respond *only* with a JSON object matching the provided schema.

Headers:
${allHeaders.join(', ')}`;

        console.log('Mapping Prompt:', mappingPrompt);

        // 4.3 Call LLM (generateObject) for mapping
        // TODO: Add mock logic if needed
        const { object: proposedMapping } = await generateObject({
            model: model, // Using the globally initialized model
            schema: mappingSchema,
            prompt: mappingPrompt,
        });
        console.log('LLM Proposed Mapping:', proposedMapping);

        // 4.4 Validate LLM mapping & Handle missing Student ID
        let { studentIdHeader, questionHeaders } = proposedMapping;
        let studentIdHeaderIsGenerated = false;

        // Check if studentIdHeader is null or invalid
        if (studentIdHeader === null || !allHeaders.includes(studentIdHeader)) {
            if (studentIdHeader !== null) {
                 console.warn(`LLM proposed studentIdHeader '${studentIdHeader}' not found in actual headers. Generating fallback ID.`);
            } else {
                 console.warn(`LLM could not identify a unique identifier column. Generating fallback ID.`);
            }
            
            // Generate fallback ID
            studentIdHeader = GENERATED_ID_HEADER; 
            studentIdHeaderIsGenerated = true;

            // Add the generated ID column to the rows data
            // Update the proposed mapping object itself FIRST
            proposedMapping.studentIdHeader = studentIdHeader;
            
            rows = rows.map((row, index) => ({
                ...row,
                // Use the updated property which TS should know is now string
                [proposedMapping.studentIdHeader!]: `Row ${index + 1}` // Simple Row ID
            }));
            
            // Update the list of all headers
            allHeaders = Object.keys(rows[0] as object);
            console.log(`Fallback ID generated. Updated headers: ${allHeaders.join(', ')}`);
            
        }
        
        // Validate Question Headers (after potential ID generation)
        // Now questionHeaders is an array of objects { header: string, isCategorical: boolean }
        const allQuestionHeaderStrings = questionHeaders.map(qh => qh.header);
        const invalidQuestionHeaders = allQuestionHeaderStrings.filter(header => !allHeaders.includes(header));
        
        if (invalidQuestionHeaders.length > 0) {
            // If the ONLY invalid header is the *generated* ID, that's okay, just filter it out.
            if (studentIdHeaderIsGenerated && invalidQuestionHeaders.length === 1 && invalidQuestionHeaders[0] === studentIdHeader) {
                console.warn(`LLM included generated studentIdHeader '${studentIdHeader}' in questionHeaders. Removing it.`);
                // Filter the array of objects
                proposedMapping.questionHeaders = questionHeaders.filter(qh => qh.header !== studentIdHeader);
                questionHeaders = proposedMapping.questionHeaders; // Update local variable too
            } else {
                 // Otherwise, it's a real error
                throw new Error(`LLM proposed questionHeaders contain invalid headers not found in the sheet (or generated ID): ${invalidQuestionHeaders.join(', ')}. Actual headers: ${allHeaders.join(', ')}`);
            }
        }
        
        // Final check: Ensure student ID header is not also listed as a question header
        // Check against the array of objects
        if (questionHeaders.some(qh => qh.header === studentIdHeader)) {
             console.warn(`LLM included studentIdHeader '${studentIdHeader}' in questionHeaders (final check). Removing it.`);
             proposedMapping.questionHeaders = questionHeaders.filter(qh => qh.header !== studentIdHeader);
        }

        console.log('Final Validated Mapping:', proposedMapping);

        // 4.5 Return proposed mapping (now includes isCategorical flags), runId, and rows
        return NextResponse.json({ runId, proposedMapping, rows });

    } catch (error) {
        console.error('Error in /api/analyze (Stage 1 - Mapping):', error);
        let errorMessage = 'An unknown error occurred.';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        return NextResponse.json({ error: 'Failed to process request', details: errorMessage }, { status: 500 });
    }
} 