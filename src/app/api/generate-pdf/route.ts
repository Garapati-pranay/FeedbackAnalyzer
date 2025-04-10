import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

// Re-define types locally if not shared
interface QuestionStats {
    [combinedCategory: string]: number; 
}
interface RunStats {
    [question: string]: QuestionStats;
}

// Re-define credentials function locally
function getSupabaseCredentials() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
        console.error('Missing Supabase environment variables for generate-pdf route');
        throw new Error('Missing Supabase environment variables');
    }
    return { supabaseUrl, supabaseServiceKey };
}

// --- PDF Generation Logic --- 
async function generatePdfStream(stats: RunStats, runId: string): Promise<Buffer> {
    // Define font paths relative to project root in the 'fonts' directory
    const regularFontPath = path.join(process.cwd(), 'fonts', 'LiberationSans-Regular.ttf');
    const boldFontPath = path.join(process.cwd(), 'fonts', 'LiberationSans-Bold.ttf');
    
    let regularFontBuffer: Buffer | null = null;
    let boldFontBuffer: Buffer | null = null;

    try {
        regularFontBuffer = fs.readFileSync(regularFontPath);
        boldFontBuffer = fs.readFileSync(boldFontPath);
    } catch (err) {
        console.error(`Error reading font files from 'fonts' directory:`, err);
        return Promise.reject(new Error(`Failed to load required font(s): ${err instanceof Error ? err.message : 'Unknown font error'}`));
    }

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const buffers: Buffer[] = [];

            // Register and set the embedded fonts
            doc.registerFont('LiberationSans-Regular', regularFontBuffer!); 
            doc.registerFont('LiberationSans-Bold', boldFontBuffer!); 
            doc.font('LiberationSans-Regular'); // Set Regular as default

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                resolve(Buffer.concat(buffers));
            });
            doc.on('error', (err) => {
                 console.error('PDF generation error:', err);
                 reject(err);
            });

            // --- PDF Content (Using registered Liberation Sans fonts) ---
            // Use Bold for main title
            doc.fontSize(18).font('LiberationSans-Bold').text('Feedback Analysis Report', { align: 'center' }).moveDown(0.5);
            // Use Regular for subtitles
            doc.fontSize(10).font('LiberationSans-Regular').text(`Run ID: ${runId}`, { align: 'center' }).text(`Generated: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`, { align: 'center' }).moveDown(1.5);
            // Use Bold for section title
            doc.fontSize(14).font('LiberationSans-Bold').text('Analysis by Question:', { underline: true }).moveDown(1);
            
             if (!stats || Object.keys(stats).length === 0) {
                doc.font('LiberationSans-Regular').fontSize(12).text('No statistics data available for this run.');
            } else {
                 Object.entries(stats).forEach(([question, categoryCounts], index) => {
                    // Use Bold for the question text
                    doc.fontSize(12).font('LiberationSans-Bold').fillColor('black').text(`${index + 1}. ${question}`).moveDown(0.5);
                    const sortedCategories = Object.entries(categoryCounts).sort(([, countA], [, countB]) => countB - countA);
                    if (sortedCategories.length === 0) {
                        // Use Regular for messages
                        doc.font('LiberationSans-Regular').fontSize(10).fillColor('black').text('   - No categories recorded.', { indent: 20 }).moveDown(0.5);
                    } else {
                        sortedCategories.forEach(([category, count]) => {
                            const categoryName = category.replace(/_/g, ' ');
                            // Use Regular for category details
                            doc.font('LiberationSans-Regular').fontSize(10).fillColor('black').text(`   - ${categoryName}: ${count} mention${count > 1 ? 's' : ''}`, { indent: 20 }).moveDown(0.2);
                        });
                    }
                    doc.moveDown(1);
                 });
            }
            // --- Finalize PDF ---
            doc.end();
            // --- End PDF Content ---
        } catch (error) {
            console.error('Error initializing PDF document:', error);
            reject(error); // Reject if setup fails
        }
    });
}

// --- API Route Handler ---
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const runId = searchParams.get('runId');

    if (!runId) {
        return new Response('Missing runId parameter', { status: 400 });
    }

    try {
        const { supabaseUrl, supabaseServiceKey } = getSupabaseCredentials();
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        console.log(`[PDF] Fetching results for runId: ${runId}`);

        // Fetch entire 'results' column
        const { data, error } = await supabase
            .from('processing_runs')
            .select('results') 
            .eq('run_id', runId)
            .maybeSingle();
        
        if (error) {
            console.error('[PDF] Supabase error fetching results column:', error);
            throw new Error(`Database error: ${error.message}`);
        }

        // Extract nested statistics 
        const statistics = data?.results?.statistics as RunStats | null;
        
        if (!statistics) { 
             console.log(`[PDF] No nested statistics data found in results column for runId: ${runId}. Data received:`, data);
             return new Response(`Statistics not found within results for run ID ${runId}`, { status: 404 });
        }

        console.log(`[PDF] Generating PDF for runId: ${runId}`);
        // Generate PDF using the extracted statistics
        const pdfBuffer = await generatePdfStream(statistics, runId);

        console.log(`[PDF] Sending PDF for runId: ${runId}`);
        // Return PDF buffer as response
        return new Response(pdfBuffer, {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="feedback_report_${runId}.pdf"`,
            },
            status: 200,
        });

    } catch (error) {
        console.error(`[PDF] Error in /api/generate-pdf for runId: ${runId}:`, error);
        const message = error instanceof Error ? error.message : 'An unknown server error occurred';
        // Return plain text error for simplicity, or JSON if preferred
        return new Response(`PDF Generation Error: ${message}`, { status: 500 }); 
    }
} 