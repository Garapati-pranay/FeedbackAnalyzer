import { NextRequest, NextResponse } from 'next/server';
// Stage 2 Imports
import { createClient } from '@supabase/supabase-js';
import { google } from '@ai-sdk/google'; 
import { generateObject, generateText } from 'ai';
import { z } from 'zod'; // Already installed
// Note: We might want common utilities for these initializations

// Define type for the question-answer pair used in prompt construction
type AnswerItem = {
    question: string;
    answer: any; // Keeping 'any' for now as spreadsheet cell types can vary
}

// --- AI Model Initialization ---
// Use gemini-2.0-flash as requested
const model = google('gemini-2.0-flash');

// --- Zod Schemas for Categorization Output ---
const categorizedAnswerSchema = z.object({
    question: z.string().describe("The exact question header text."),
    topic: z.string().describe("Concise keyword/phrase for the main subject (e.g., 'cleanliness', 'driver_attitude'). Use 'general' or 'n/a' if no specific topic."),
    sentiment: z.enum(['positive', 'negative', 'neutral', 'n/a']).default('neutral').describe("Sentiment about the topic ('positive', 'negative', 'neutral', 'n/a')."),
    sub_category: z.string().optional().describe("Optional: A few keywords explaining the specific REASON for the sentiment (e.g., 'long_wait_times', 'ends_too_early', 'vehicle_dirty', 'app_crashes', 'staff_friendly'). Omit if no specific reason is clear.")
});

const categorizedStudentSchema = z.object({
    respondentId: z.string().describe("The unique identifier for the respondent, matching one provided in the input."),
    categorizations: z.array(categorizedAnswerSchema).describe("An array of categorizations (topic and sentiment) for each question asked to this respondent.")
});

// Schema for the entire batch output - an array of categorized students
const batchCategorizationSchema = z.array(categorizedStudentSchema);

// Type definition for the structure coming from the analyze step
interface QuestionHeaderInfo {
    header: string;
    isCategorical: boolean;
}
interface ConfirmedMapping {
    studentIdHeader: string; // Analyze step ensures this is never null by the time it reaches here
    questionHeaders: QuestionHeaderInfo[];
}

// Use Edge Runtime for streaming
export const runtime = 'edge';
// Disable bodyParser - we parse manually in Edge functions
export const config = {
  api: {
    bodyParser: false,
  },
};

// Type for streaming messages
type StreamMessage = 
    | { type: 'batchStart'; index: number; total: number } 
    | { type: 'result'; data: z.infer<typeof categorizedStudentSchema> }
    | { type: 'stats'; data: RunStats }
    | { type: 'summary'; text: string }
    | { type: 'error'; message: string; batchIndex?: number }
    | { type: 'complete'; message: string };

// --- Mock LLM Function (Updated for generateObject structure AND new schema) ---
async function mockAnalyzeFeedbackBatch(prompt: string): Promise<{ object: z.infer<typeof batchCategorizationSchema> }> {
    console.warn('Using mock LLM response! (in /api/process - structured)');
    await new Promise(resolve => setTimeout(resolve, 50)); 
    const mockRespondentIds = (prompt.match(/Respondent ID: (.*)/g) || []).map(s => s.replace('Respondent ID: ', '').trim());
    
    const mockResponseObject = mockRespondentIds.map(id => ({
        respondentId: id || `MockRespondent_${Math.random().toString(16).slice(2, 8)}`, 
        categorizations: [
            // Ensure sentiment values match the enum
            { question: "Mock Question 1", topic: "mock_topic_1", sentiment: "positive" as const }, 
            { question: "Mock Question 2", topic: "mock_topic_2", sentiment: "neutral" as const } 
        ]
    }));
    
    // Type assertion to satisfy the schema rigorously, although structure matches
    return { object: mockResponseObject as z.infer<typeof batchCategorizationSchema> }; 
}

// Function to get Supabase credentials (copy/adapt from analyze route or move to shared util)
function getSupabaseCredentials() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error('Missing Supabase environment variables');
    }
    return { supabaseUrl, supabaseAnonKey };
}

// Update RunStats structure to potentially store combined keys
// Example: { "question1": { "cleanliness_positive": 5, "cleanliness_negative": 2 } }
interface QuestionStats {
    [combinedCategory: string]: number; // Combined topic_sentiment_subcategory
}
interface RunStats {
    [question: string]: QuestionStats;
}

const BATCH_SIZE = 50;
const SUB_CATEGORY_DEFAULT = 'detail_na'; // Moved constant here

export async function POST(req: NextRequest) {
    console.log('Received stream request in /api/process');
    
    // --- Read Env Vars ---
    // Ensure we respect the mock flag in this route too
    const useMockLlm = process.env.USE_MOCK_LLM === 'true';
    console.log(`Using mock LLM in process route: ${useMockLlm}`);

    let requestData;
    try {
        requestData = await req.json();
    } catch (e) {
        return new Response(JSON.stringify({ type: 'error', message: 'Invalid request body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const { runId, confirmedMapping, rows } = requestData;
    // Destructure with the new type for confirmedMapping
    const { studentIdHeader, questionHeaders }: ConfirmedMapping = confirmedMapping || { studentIdHeader: '', questionHeaders: [] };

    // Basic validation - Check if questionHeaders is an array with items
    if (!runId || !confirmedMapping || !rows || !Array.isArray(rows) || !studentIdHeader || !Array.isArray(questionHeaders) || questionHeaders.length === 0) {
         return new Response(JSON.stringify({ type: 'error', message: 'Invalid request payload' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Create a stream and encoder
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {

            function sendStreamMessage(message: StreamMessage) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
            }

            try {
                console.log(`Processing run ID: ${runId}`);
                
                // Initialize Supabase Client
                const { supabaseUrl, supabaseAnonKey } = getSupabaseCredentials();
                const supabase = createClient(supabaseUrl, supabaseAnonKey);
                console.log('Supabase client initialized in /api/process stream.');

                const totalBatches = Math.ceil(rows.length / BATCH_SIZE);

                // Initialize array to hold all results for the run
                const allRunCategorizations: any[] = [];
                const identifiedTopics = new Set<string>();
                const identifiedSubCategories = new Set<string>();

                for (let i = 0; i < rows.length; i += BATCH_SIZE) {
                    const batch = rows.slice(i, i + BATCH_SIZE);
                    const batchNumber = i / BATCH_SIZE + 1;
                    
                    sendStreamMessage({ type: 'batchStart', index: batchNumber, total: totalBatches });
                    console.log(`Processing batch ${batchNumber}/${totalBatches}`);

                    // --- Separate Qualitative and Categorical Questions --- 
                    const qualitativeQuestions = questionHeaders.filter(q => !q.isCategorical);
                    const categoricalQuestions = questionHeaders.filter(q => q.isCategorical);

                    // --- Directly process CATEGORICAL answers for this batch --- 
                    batch.forEach((row: any, index: number) => {
                        const respondentId = row[studentIdHeader] ?? `Row ${i + index + 1} (No ID)`;
                        categoricalQuestions.forEach(qInfo => {
                            const question = qInfo.header;
                            const answer = row[question];
                            const normalizedAnswer = String(answer ?? '').trim().toLowerCase().replace(/\s+/g, '_') || SUB_CATEGORY_DEFAULT;
                            // Use normalized question header as topic for simplicity, or derive something else?
                            const topic = question.trim().toLowerCase().replace(/\s+/g, '_'); 

                            allRunCategorizations.push({
                                run_id: runId, 
                                student_identifier: respondentId, 
                                question_text: question, 
                                original_answer: String(answer ?? ''), 
                                topic: topic,       
                                sentiment: 'n/a', // Explicitly set sentiment to n/a
                                sub_category: normalizedAnswer // The answer itself is the sub-category
                            });
                        });
                    });
                    console.log(`Directly processed ${categoricalQuestions.length} categorical questions for batch ${batchNumber}.`);

                    // --- Construct batch prompt ONLY for QUALITATIVE questions --- 
                    let qualitativeDataExistsInBatch = false;
                    const batchInputForPrompt = batch.map((row: any, index: number) => {
                        const respondentId = row[studentIdHeader] ?? `Row ${i + index + 1} (No ID)`;
                        // Only include answers for qualitative questions
                        const answers = qualitativeQuestions.map(qInfo => ({
                            question: qInfo.header,
                            answer: row[qInfo.header] ?? ''
                        }));
                        // Check if there's any non-empty answer for qualitative questions
                        if (answers.some(a => String(a.answer ?? '').trim() !== '')) {
                            qualitativeDataExistsInBatch = true;
                        }
                        return { respondentId, answers };
                    });

                    // Only call AI if there are qualitative questions AND some data for them in this batch
                    if (qualitativeQuestions.length > 0 && qualitativeDataExistsInBatch) {
                        let batchPrompt = "You are analyzing feedback. For each respondent listed below, analyze ONLY their answers to the provided QUALITATIVE questions. " +
                                          "For each answer, identify the **main topic**, the **sentiment** expressed ('positive', 'negative', 'neutral', 'n/a'), " +
                                          "and optionally, a **professional and concise sub_category** summarizing the specific REASON for the sentiment (e.g., 'schedule_conflict', 'instructor_clarity', 'difficult_navigation', 'helpful_support_staff'). Sub-category titles should sound like formal report points. **CRITICAL: Before creating a NEW sub_category, check if any existing sub_category under the SAME topic and sentiment (see list below, if provided) accurately represents the feedback's core reason. Strongly prefer reusing an existing sub-category if the meaning is similar.** Only create a new sub-category if the reason is genuinely distinct and cannot be captured by existing ones. Only include sub_category if a specific reason is clearly stated or implied. " +
                                          "Respond *only* with a JSON array matching the schema.\n";
                        
                        // Add context (topics/subcategories identified from PREVIOUS qualitative analysis)
                        if (batchNumber > 1 && identifiedTopics.size > 0) {
                            const topicList = Array.from(identifiedTopics).slice(0, 30).join(', '); // Limit context
                            batchPrompt += `\nPreviously identified topics: [${topicList}]. Reuse these if appropriate.`;
                        }
                        if (batchNumber > 1 && identifiedSubCategories.size > 0) {
                            const subCategoryList = Array.from(identifiedSubCategories).slice(0, 50).join(', '); // Limit context
                            batchPrompt += `\nPreviously identified sub-categories: [${subCategoryList}]. Reuse these specific reasons if appropriate.`;
                        }

                        batchPrompt += "\n\nInput Data (Qualitative Only):\n";
                        
                        // Append structured input data representation to the prompt (Qualitative Only)
                        batchInputForPrompt.forEach(item => {
                             // Only include respondents who actually answered qualitative questions
                            if (item.answers.some(a => String(a.answer ?? '').trim() !== '')) {
                                batchPrompt += `\nRespondent ID: ${item.respondentId}\n`;
                                item.answers.forEach((qa: { question: string; answer: any }) => {
                                    // Include even if answer is empty now, AI should handle it
                                    batchPrompt += `  Question: ${qa.question}\n  Answer: ${qa.answer}\n`;
                                });
                                batchPrompt += `---\n`;
                            }
                        });
                        
                        console.log(`Batch Prompt for LLM (Batch ${batchNumber} - Qualitative Only):
${batchPrompt.substring(0, 500)}...`); // Log truncated prompt

                        // --- Call LLM using generateObject --- 
                        let batchResultObject: z.infer<typeof batchCategorizationSchema> | null = null;
                        try {
                            if (useMockLlm) {
                                // Mock logic needs update if it depends on prompt structure for IDs
                                const { object } = await mockAnalyzeFeedbackBatch(batchPrompt);
                                batchResultObject = object;
                            } else {
                                const { object } = await generateObject({ // Use generateObject
                                    model: model,
                                    schema: batchCategorizationSchema, // Schema remains same
                                    prompt: batchPrompt,
                                });
                                batchResultObject = object;
                            }
                            console.log(`LLM Structured Response (Batch ${batchNumber}):`, batchResultObject);

                            // --- Parsing & Normalization (Only for AI results) --- 
                            if (batchResultObject) {
                                batchResultObject.forEach(studentResult => {
                                    studentResult.categorizations.forEach(cat => {
                                        // Normalize Topic & add to set
                                        let normalizedTopic = cat.topic?.trim().toLowerCase().replace(/\s+/g, '_') || 'n/a';
                                        cat.topic = normalizedTopic; 
                                        if (normalizedTopic !== 'n/a') identifiedTopics.add(normalizedTopic); // Add AI topics
                                        
                                        // Normalize Sentiment
                                        cat.sentiment = cat.sentiment || 'neutral'; 

                                        // Normalize SubCategory & add to set
                                        let normalizedSubCategory = cat.sub_category?.trim().toLowerCase().replace(/\s+/g, '_') || null;
                                        if (normalizedSubCategory === '') normalizedSubCategory = null;
                                        cat.sub_category = normalizedSubCategory ?? undefined; 
                                        if (normalizedSubCategory) { 
                                             identifiedSubCategories.add(normalizedSubCategory); // Add AI sub-cats
                                        }
                                    });
                                });
                                console.log(`Normalized AI Response & Updated Context (Batch ${batchNumber}):`, batchResultObject);
                                
                                // --- Accumulate AI Results --- 
                                for (const respondentResult of batchResultObject) {
                                    sendStreamMessage({ type: 'result', data: respondentResult });

                                    // Find original row to get original answer text
                                    const originalRow = batch.find((row: any, index: number) => {
                                        const originalId = row[studentIdHeader] ?? `Row ${i + index + 1} (No ID)`;
                                        return originalId === respondentResult.respondentId;
                                    });
                                    
                                    if (originalRow) {
                                        respondentResult.categorizations.forEach(categorization => {
                                            // Ensure we only add results for questions processed by AI
                                            if (qualitativeQuestions.some(q => q.header === categorization.question)) {
                                                allRunCategorizations.push({
                                                    run_id: runId, 
                                                    student_identifier: respondentResult.respondentId, 
                                                    question_text: categorization.question, 
                                                    original_answer: originalRow[categorization.question] ?? '', 
                                                    topic: categorization.topic,       
                                                    sentiment: categorization.sentiment,      
                                                    sub_category: categorization.sub_category
                                                });
                                            }
                                        });
                                    } else {
                                         console.warn(`Could not find original row data for respondent ID: ${respondentResult.respondentId} while accumulating AI results.`);
                                    }
                                } // End accumulating AI results

                            } else {
                                 throw new Error('LLM returned null or invalid object for qualitative data.');
                            }
                        } catch (llmError) {
                            const message = llmError instanceof Error ? llmError.message : 'Unknown LLM/Processing error';
                            console.error(`Error processing batch ${batchNumber}:`, llmError);
                            sendStreamMessage({ type: 'error', message: `Processing error in batch ${batchNumber}: ${message}`, batchIndex: batchNumber });
                            // Continue to next batch on error
                        }
                    } else {
                         console.log(`Skipping AI call for batch ${batchNumber} as no qualitative questions or data were found.`);
                    }
                } // End batch loop

                console.log('Finished processing all batches. Calculating stats from memory...');

                // --- Calculate Aggregated Stats from Memory (No change needed) --- 
                let runStats: RunStats = {};
                // SUB_CATEGORY_DEFAULT already defined above
                try {
                    // This existing reduce logic should work correctly as it uses the combined key
                    // including the sentiment ('n/a' for categorical)
                    runStats = allRunCategorizations.reduce((acc: RunStats, record) => {
                       // ... existing stats calculation logic ...
                       // Corrected logic as per previous state:
                        const { question_text, topic, sentiment, sub_category } = record;
                        if (!question_text || !topic || !sentiment) return acc;
                        const subCategoryKey = sub_category || SUB_CATEGORY_DEFAULT;
                        const combinedCategory = `${topic}_${sentiment}_${subCategoryKey}`;
                        if (!acc[question_text]) acc[question_text] = {};
                        acc[question_text][combinedCategory] = (acc[question_text][combinedCategory] || 0) + 1;
                        return acc;
                    }, {});
                    console.log('Calculated Combined Stats from memory (Mixed Types):', runStats);
                    sendStreamMessage({ type: 'stats', data: runStats });
                } catch (statsCalcError) {
                    const message = statsCalcError instanceof Error ? statsCalcError.message : 'Unknown error calculating stats from memory';
                    console.error('Error calculating/sending stats from memory:', statsCalcError);
                    sendStreamMessage({ type: 'error', message: `Failed to calculate statistics: ${message}` });
                    // Reset stats if calculation failed?
                    runStats = {}; 
                }

                // --- Generate AI Summary --- 
                let summaryText = 'AI summary could not be generated.'; // Default text
                if (Object.keys(runStats).length > 0 && !useMockLlm) { // Only generate if stats exist and not mocking
                    try {
                        const statsString = JSON.stringify(runStats, null, 2);
                        // Updated prompt: quantitative, user-friendly names, bolding, hyphens, concise but comprehensive
                        const summaryPrompt = `You are an analyst reviewing feedback statistics. Provide a **concise** summary (around 3-5 points) highlighting the most **significant findings** based on the following JSON data.

**Format:** Use hyphens (-) for list items, not asterisks (*).

**Content Requirements:**
1.  Include specific counts or percentages for **significant findings**. This includes the most frequent responses/themes, but also any **particularly strong negative feedback or notable outliers**, even if less frequent.
2.  Use natural language descriptions for categories/answers (e.g., 'positive feedback about campus involvement', '10 to 19 hours'). **Do NOT include raw underscore_separated keys.**
3.  Use markdown bold (**text**) to highlight the most important statistics, findings, or areas potentially needing attention.
4.  Provide a **balanced overview** covering major themes, overall sentiment distribution (mentioning dominant sentiments and any noteworthy negative points), and key categorical response patterns.

Statistics:
${statsString}`;
                        
                        console.log('Generating AI summary...');
                        const { text } = await generateText({
                            model: model, // Use the same model
                            prompt: summaryPrompt,
                            // Add parameters like maxTokens if needed to control length
                        });
                        summaryText = text;
                        console.log('AI Summary Generated:', summaryText);
                        // Send summary via stream
                        sendStreamMessage({ type: 'summary', text: summaryText });
                    } catch (summaryError) {
                        const message = summaryError instanceof Error ? summaryError.message : 'Unknown error generating summary';
                        console.error('Error generating AI summary:', summaryError);
                        sendStreamMessage({ type: 'error', message: `Failed to generate AI summary: ${message}` });
                        // Use the default summaryText
                    }
                } else if (useMockLlm) {
                     summaryText = "Mock Summary: Feedback shows mixed results with some positive comments about X and negative comments about Y.";
                     console.log("Using mock AI summary.");
                     sendStreamMessage({ type: 'summary', text: summaryText });
                } else {
                     console.log("Skipping AI summary generation as no stats were calculated.");
                     // Keep default summaryText
                     sendStreamMessage({ type: 'summary', text: summaryText }); // Still send default
                }

                // --- Save Final Results to 'processing_runs' Table --- 
                try {
                    // Include the summary in the data saved to Supabase
                    const finalRunData = {
                        categorizations: allRunCategorizations,
                        statistics: runStats,
                        summary: summaryText
                    };
                    console.log(`Attempting to save/update final JSON blob (with summary) for run ${runId} to processing_runs...`);
                    const { error: upsertError } = await supabase
                        .from('processing_runs')
                        .upsert({ 
                            run_id: runId,
                            results: finalRunData, 
                            status: 'completed',
                        }, { 
                            onConflict: 'run_id'
                        });

                    if (upsertError) {
                        // Log the full error structure
                        console.error('Supabase upsert error object:', upsertError);
                        // Construct message safely
                        const errorMessage = upsertError.message || 'No error message provided by Supabase (check server logs)';
                        throw new Error(`Failed to save/update final run results in processing_runs: ${errorMessage}`);
                    }
                    console.log(`Saved/Updated final results JSON for run ${runId} in processing_runs table.`);
                } catch (saveError) {
                    const message = saveError instanceof Error ? saveError.message : 'Unknown error saving final results';
                    console.error('Error saving final run results:', saveError);
                    // Send error message to frontend, but proceed to 'complete' anyway
                    sendStreamMessage({ type: 'error', message: `Failed to save final results: ${message}` });
                }
                
                // Send completion message
                sendStreamMessage({ type: 'complete', message: `Processing and statistics finished for ${rows.length} rows.` });
                controller.close();

            } catch (processError) {
                // Catch errors from setup (e.g., Supabase init)
                 const message = processError instanceof Error ? processError.message : 'Unknown server error';
                console.error('Error during stream processing setup:', processError);
                sendStreamMessage({ type: 'error', message: `Server error: ${message}` });
                controller.close();
            }
        }
    });

    return new Response(stream, {
        headers: { 
            'Content-Type': 'text/event-stream', 
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
         },
    });
} 