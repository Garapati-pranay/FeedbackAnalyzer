import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Function to get Supabase credentials...
function getSupabaseCredentials() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
        console.error('Missing Supabase environment variables for get-results route');
        throw new Error('Missing Supabase environment variables');
    }
    return { supabaseUrl, supabaseServiceKey };
}

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const runId = searchParams.get('runId'); // runId is defined here

    if (!runId) {
        return NextResponse.json({ error: 'Missing runId parameter' }, { status: 400 });
    }

    try {
        const { supabaseUrl, supabaseServiceKey } = getSupabaseCredentials();
        const supabase = createClient(supabaseUrl, supabaseServiceKey); // supabase is defined here

        console.log(`Fetching results for runId: ${runId}`);

        const { data, error } = await supabase
            .from('processing_runs')
            .select('results') 
            .eq('run_id', runId)
            .maybeSingle();

        // Enhanced Logging
        console.log(`Supabase query completed for runId: ${runId}`);
        console.log(`   Error object:`, error); 
        // Use try-catch for stringify in case data is complex/circular, although unlikely here
        try {
            console.log(`   Data object received:`, JSON.stringify(data, null, 2)); 
        } catch (stringifyError) {
            console.error('Error stringifying received data object:', stringifyError);
            console.log('   Raw Data object received:', data);
        }

        if (error) {
            console.error('Supabase error fetching results:', error);
            throw new Error(`Database error: ${error.message}`);
        }

        // Explicit checks with logging
        if (!data) {
            console.log(`Condition failed: !data is true (no row found for runId: ${runId}).`);
            return NextResponse.json({ error: `Results not found for the specified run ID ${runId} (no data obj)` }, { status: 404 });
        } else if (!data.results) {
             // Check if the key 'results' exists but is null/undefined vs key not existing
             const resultsValue = data.hasOwnProperty('results') ? data.results : '[results key not present]';
             console.log(`Condition failed: data.results is falsy for runId: ${runId}. Value:`, resultsValue);
             return NextResponse.json({ error: `Results not found for the specified run ID ${runId} (results field empty/missing)` }, { status: 404 });
        } else {
             console.log(`Condition passed for runId: ${runId}: data and data.results are truthy.`);
        }

        console.log(`Successfully fetched results for runId: ${runId}`);
        return NextResponse.json(data.results, { status: 200 });

    } catch (error) {
        console.error(`Error in /api/get-results for runId: ${runId}:`, error);
        const message = error instanceof Error ? error.message : 'An unknown server error occurred';
        return NextResponse.json({ error: message }, { status: 500 });
    }
} 