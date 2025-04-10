import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Function to get Supabase credentials (ensure service key is used for potentially sensitive data)
function getSupabaseCredentials() {
    const supabaseUrl = process.env.SUPABASE_URL;
    // Use service role key for server-side access if needed, otherwise anon key is fine if RLS allows
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
        console.error('Missing Supabase environment variables for get-results route');
        throw new Error('Missing Supabase environment variables');
    }
    return { supabaseUrl, supabaseServiceKey };
}

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const runId = searchParams.get('runId');

    if (!runId) {
        return NextResponse.json({ error: 'Missing runId parameter' }, { status: 400 });
    }

    try {
        const { supabaseUrl, supabaseServiceKey } = getSupabaseCredentials();
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        console.log(`[API GetResults] Fetching results for runId: ${runId}`);

        // Fetch the specific columns needed for the results page
        // We need the results blob and the original proposed mapping
        // NOTE: Ensure 'mapping' column exists in your 'processing_runs' table and stores the mapping used
        const { data, error } = await supabase
            .from('processing_runs')
            .select('results, mapping, created_at') // Fetch results blob, mapping, and creation time
            .eq('run_id', runId)
            .maybeSingle(); // Expect only one row for a unique runId

        if (error) {
            console.error('[API GetResults] Supabase error:', error);
            throw new Error(`Database error: ${error.message}`);
        }

        if (!data) {
            console.log(`[API GetResults] No data found for runId: ${runId}`);
            return NextResponse.json({ error: 'Results not found for the given Run ID.' }, { status: 404 });
        }

        // Validate fetched data structure (basic)
        if (!data.results || !data.mapping) {
             console.error(`[API GetResults] Missing 'results' or 'mapping' data for runId: ${runId}`, data);
             return NextResponse.json({ error: 'Incomplete results data found.' }, { status: 500 });
        }


        // Return the necessary data
        // The 'results' field contains { statistics, summary, categorizations }
        console.log(`[API GetResults] Successfully fetched data for runId: ${runId}`);
        return NextResponse.json({
            runId: runId,
            results: data.results, // Contains stats, summary, categorizations
            mapping: data.mapping, // Contains studentIdHeader, questionHeaders
            createdAt: data.created_at
        });

    } catch (error) {
        console.error(`[API GetResults] Error fetching results for runId: ${runId}:`, error);
        const message = error instanceof Error ? error.message : 'An unknown server error occurred';
        return NextResponse.json({ error: `Failed to fetch results: ${message}` }, { status: 500 });
    }
}