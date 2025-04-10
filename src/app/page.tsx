'use client'; // This marks the component as a Client Component

import { useState, FormEvent, ChangeEvent, useEffect, useRef } from 'react';
// Import framer-motion
import { motion, AnimatePresence } from 'framer-motion';
// Import recharts
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
// Import SheetJS
import * as XLSX from 'xlsx';
// Import react-markdown
import ReactMarkdown from 'react-markdown';
// Import jsPDF
import jsPDF from 'jspdf';

// Define the structure of the mapping object
interface Mapping {
  studentIdHeader: string;
  questionHeaders: { header: string }[];
}

// Add interface for individual result item
interface CategorizationResult {
  respondentId: string;
  question: string;
  category: string;
}

// Add interface for Stats data
interface QuestionStats {
    [category: string]: number;
}
interface RunStats {
    [question: string]: QuestionStats;
}

// Change liveResults state structure
// Key: respondentId, Value: Record<questionHeader, category>
type LiveResultsState = Map<string, Record<string, string>>;

// Change frontend BATCH_SIZE from 5 to 50 to match backend
const BATCH_SIZE = 50; // Define batch size on frontend too for highlighting
const HIGHLIGHT_DELAY_MS = 700; // Adjust speed of highlight progression

// Define default sub-category key for consistency
const SUB_CATEGORY_DEFAULT = 'detail_na';
// Define possible sentiments for parsing
const SENTIMENTS = ['positive', 'negative', 'neutral', 'n/a'];

// Define a preferred sort order for sentiments
const SENTIMENT_ORDER = ['positive', 'negative', 'neutral', 'n/a'];

// Helper function to parse the combined key
function parseCombinedCategory(combinedKey: string): { topic: string; sentiment: string; subCategory: string | null } {
    let topic = 'N/A';
    let sentiment = 'N/A';
    let subCategory: string | null = null;

    for (const s of SENTIMENTS) {
        const sentimentMarker = `_${s}_`;
        const index = combinedKey.indexOf(sentimentMarker);

        if (index !== -1) {
            topic = combinedKey.substring(0, index).replace(/_/g, ' ') || 'N/A';
            sentiment = s;
            const subCategoryRaw = combinedKey.substring(index + sentimentMarker.length).replace(/_/g, ' ');
            if (subCategoryRaw && subCategoryRaw !== SUB_CATEGORY_DEFAULT.replace(/_/g, ' ')) {
                subCategory = subCategoryRaw;
            }
            break; // Found the sentiment, stop searching
        }
    }

    // Fallback if sentiment marker wasn't found (shouldn't happen with backend logic)
    if (topic === 'N/A') {
        const parts = combinedKey.split('_');
        topic = parts[0]?.replace(/_/g, ' ') || 'N/A';
        sentiment = parts[1] || 'N/A';
        const subCategoryRaw = parts.slice(2).join(' ').replace(/_/g, ' ');
         if (subCategoryRaw && subCategoryRaw !== SUB_CATEGORY_DEFAULT.replace(/_/g, ' ')) {
            subCategory = subCategoryRaw;
        }
    }

    return { topic, sentiment, subCategory };
}

// Type for the new nested structure
interface GroupedSubCategoryStats {
  [subCategory: string]: number;
}
interface GroupedSentimentStats {
  [sentiment: string]: GroupedSubCategoryStats;
}
interface GroupedTopicStats {
  [topic: string]: GroupedSentimentStats;
}
interface GroupedQuestionStats {
  [question: string]: GroupedTopicStats;
}

// Helper component to format the AI Summary using react-markdown
function AiSummaryDisplay({ summaryText }: { summaryText: string | null }) {
    if (!summaryText) return null;

    // Use react-markdown to render the text, applying Tailwind styles for elements
    // Apply base styles to a wrapper div
    return (
        <div className="text-sm text-gray-700 space-y-2">
            <ReactMarkdown
                // No className directly on ReactMarkdown
                components={{
                    p: ({node, ...props}) => <p className="my-1" {...props} />,
                    ul: ({node, ...props}) => <ul className="list-disc list-inside space-y-1 pl-4" {...props} />,
                    li: ({node, ...props}) => <li className="my-0.5" {...props} />,
                    // strong/bold tags are handled by default
                }}
            >
                {summaryText}
            </ReactMarkdown>
        </div>
    );
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [isError, setIsError] = useState<boolean>(false);
  const [proposedMapping, setProposedMapping] = useState<Mapping | null>(null);
  const [stage, setStage] = useState<'upload' | 'confirm' | 'processing' | 'complete'>('upload');
  const [runId, setRunId] = useState<string | null>(null);
  const [rowsData, setRowsData] = useState<unknown[] | null>(null);
  const [highlightedBatchIndex, setHighlightedBatchIndex] = useState<number>(-1); // -1 means none highlighted
  const [liveResults, setLiveResults] = useState<LiveResultsState>(new Map());
  const [statsData, setStatsData] = useState<RunStats | null>(null);
  const [groupedStats, setGroupedStats] = useState<GroupedQuestionStats | null>(null);
  const [detailedCategorizations, setDetailedCategorizations] = useState<any[] | null>(null);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [modalTitle, setModalTitle] = useState<string>('');
  const [modalComments, setModalComments] = useState<{ id: string, comment: string }[]>([]);
  const [aiSummary, setAiSummary] = useState<string | null>(null);

  // Ref to manage the highlight timer
  const highlightTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      setFile(event.target.files[0]);
      setStatusMessage('');
      setIsError(false);
      setProposedMapping(null);
      setRunId(null);
      setRowsData(null);
      setLiveResults(new Map()); // Reset Map
      setHighlightedBatchIndex(-1);
      setStatsData(null); // Reset stats
      setAiSummary(null);
      setStage('upload');
    } else {
      setFile(null);
    }
  };

  // Handles the initial file submission to get mapping
  const handleSubmitForMapping = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) {
      setStatusMessage('Please select a file first.');
      setIsError(true);
      return;
    }

    setIsLoading(true);
    setStatusMessage('Uploading and analyzing headers...');
    setIsError(false);
    setProposedMapping(null);
    setRunId(null);
    setRowsData(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.details || result.error || `HTTP error! status: ${response.status}`);
      }
      
      // Expect proposedMapping, runId, and rows
      if (result.proposedMapping && result.runId && result.rows) {
        setProposedMapping(result.proposedMapping as Mapping);
        setRunId(result.runId as string);
        setRowsData(result.rows as unknown[]);
        setStage('confirm');
        setStatusMessage('');
      } else {
        throw new Error('API did not return the expected mapping, runId, or rows data.');
      }

    } catch (error) {
      console.error('Error during header analysis:', error);
      setStatusMessage(`Error: ${error instanceof Error ? error.message : 'An unknown error occurred.'}`);
      setIsError(true);
      setStage('upload'); // Stay on upload stage on error
    } finally {
      setIsLoading(false);
    }
  };

  // Placeholder for handling the confirmation step
  const handleConfirmMapping = async () => {
    if (!proposedMapping || !runId || !rowsData) return;
    setLiveResults(new Map()); // Clear results on new confirmation
    setHighlightedBatchIndex(-1);
    if (highlightTimerRef.current) {
        clearInterval(highlightTimerRef.current);
        highlightTimerRef.current = null;
    }
    setAiSummary(null);

    setIsLoading(true);
    setStage('processing');
    setStatusMessage('Processing feedback, please wait...');
    setIsError(false);
    setStatsData(null); // Clear stats on new run

    try {
      const response = await fetch('/api/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          runId, 
          confirmedMapping: proposedMapping, 
          rows: rowsData 
        }),
      });

      if (!response.ok) {
        // Try to read error from body if available, otherwise use status text
        let errorBody = { message: response.statusText };
        try {
          errorBody = await response.json();
        } catch (_) { /* ignore parsing error */ }
        throw new Error(errorBody.message || `HTTP error! status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      // Process the stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const stream = new ReadableStream({
        async start(controller) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || ''; 
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const jsonString = line.substring(6); 
                    try {
                        const message = JSON.parse(jsonString);
                        switch (message.type) {
                            case 'batchStart':
                                console.log(`Stream: Starting Batch ${message.index}/${message.total}`);
                                setHighlightedBatchIndex(message.index - 1); // Update highlight based on backend
                                setStatusMessage(`Processing Batch ${message.index} of ${message.total}...`);
                                break;
                            case 'result':
                                console.log('Stream: Received result (with subcat):', message.data); 
                                setLiveResults(prevMap => {
                                    const newMap = new Map(prevMap);
                                    const respondentData = message.data;
                                    const currentCategories = newMap.get(respondentData.respondentId) || {};
                                    respondentData.categorizations.forEach((cat: any) => {
                                        // <<< MODIFICATION START: Store 3-part category in live results >>>
                                        const topic = cat.topic?.replace(/_/g, ' ') || 'N/A';
                                        const sentiment = cat.sentiment || 'N/A';
                                        // Handle optional sub_category, don't show if default/missing
                                        const subCategory = cat.sub_category && cat.sub_category !== SUB_CATEGORY_DEFAULT 
                                            ? cat.sub_category.replace(/_/g, ' ') 
                                            : null;
                                        
                                        let displayCategory = `${topic} (${sentiment})`;
                                        if (subCategory) {
                                            displayCategory += ` - ${subCategory}`;
                                        }
                                        currentCategories[cat.question] = displayCategory;
                                        // <<< MODIFICATION END >>>
                                    });
                                    newMap.set(respondentData.respondentId, currentCategories);
                                    return newMap;
                                });
                                break;
                            case 'stats': // Already receives 3-part keys from updated backend
                                console.log('Stream: Received stats (3-part key):', message.data);
                                setStatsData(message.data as RunStats);
                                break;
                            case 'summary':
                                console.log('Stream: Received AI Summary:', message.text);
                                setAiSummary(message.text);
                                break;
                            case 'error':
                                // Add type check for message.message
                                const errorText = typeof message?.message === 'string' 
                                    ? message.message 
                                    : 'An unspecified error occurred via stream.';
                                console.error('Stream: Received error:', errorText, 'Original message:', message);
                                setStatusMessage(`Error during processing: ${errorText}`);
                                setIsError(true);
                                // Optionally stop processing or just log
                                break;
                            case 'complete':
                                console.log('Stream: Received complete message');
                                setIsLoading(false);
                                setStage('complete');
                                setHighlightedBatchIndex(-1); // Clear highlight
                                reader.cancel(); // Ensure reader is cancelled
                                return; // Exit the loop and function
                            default:
                                 console.warn('Stream: Received unknown message type:', message);
                        }
                    } catch (parseError) {
                        console.error('Stream: Error parsing JSON from SSE line:', jsonString, parseError);
                    }
                }
            } // end for loop
          } // end while loop
        }
      });

    } catch (error) {
      console.error('Error fetching or processing stream:', error);
      setStatusMessage(`Error: ${error instanceof Error ? error.message : 'An unknown error occurred.'}`);
      setIsError(true);
      setStage('confirm'); 
    } finally {
      setIsLoading(false);
      // No need to clear timer here as it's replaced by stream
    }
  };

  // Handle cancelling the confirmation
  const handleCancel = () => {
    setFile(null);
    setProposedMapping(null);
    setStatusMessage('');
    setIsError(false);
    setRunId(null);
    setRowsData(null);
    setLiveResults(new Map()); // Reset Map
    setHighlightedBatchIndex(-1);
    setStatsData(null); // Reset stats
    setAiSummary(null);
    setStage('upload');
    // Reset file input visually (optional)
    const fileInput = document.getElementById('file-upload') as HTMLInputElement;
    if (fileInput) {
        fileInput.value = '';
    }
  };

  // --- Download Handler JSON ---
  const handleDownloadJson = async () => {
    if (!runId) {
      setStatusMessage('Cannot download results: Run ID is missing.');
      setIsError(true);
      return;
    }

    setStatusMessage('Preparing download...');
    setIsError(false);
    const downloadButton = document.getElementById('download-button') as HTMLButtonElement;
    if(downloadButton) downloadButton.disabled = true; // Disable button during download

    try {
      const response = await fetch(`/api/get-results?runId=${runId}`);
      
      if (!response.ok) {
        let errorData = { message: `HTTP error! status: ${response.status}` };
        try {
            // Try parsing JSON error from backend
            const body = await response.json(); 
            errorData.message = body.error || errorData.message; 
        } catch (_) { /* Ignore if body is not JSON */ }
        throw new Error(errorData.message);
      }
      
      const resultsData = await response.json(); 
      
      if (!resultsData) { // Should be handled by 404 from API, but check anyway
         throw new Error('No results data returned from API.');
      }
      
      // Create and trigger download
      const jsonString = JSON.stringify(resultsData, null, 2); // Pretty print JSON
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `feedback_results_${runId}.json`; // Filename includes runId
      document.body.appendChild(link);
      link.click(); // Trigger download
      document.body.removeChild(link); // Clean up link element
      URL.revokeObjectURL(url); // Free up memory
      
      setStatusMessage('Results downloaded successfully.');
      setIsError(false);

    } catch (error) {
      console.error('Error downloading results:', error);
      setStatusMessage(`Error downloading results: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsError(true);
    } finally {
      if(downloadButton) downloadButton.disabled = false; // Re-enable button
    }
  };

  // --- Download Handler PDF (Client-Side) --- 
  const handleDownloadPdf = () => {
    if (!runId || (!aiSummary && !groupedStats)) {
        setStatusMessage('No summary or detailed data available to generate PDF report.');
        setIsError(true);
        return;
    }
    
    setStatusMessage('Generating PDF report...');
    setIsError(false);
    const downloadButton = document.getElementById('download-pdf-button') as HTMLButtonElement;
    if(downloadButton) downloadButton.disabled = true;

    try {
        const doc = new jsPDF();
        const pageHeight = doc.internal.pageSize.height;
        const pageWidth = doc.internal.pageSize.width;
        const margin = 15;
        const maxLineWidth = pageWidth - margin * 2;
        let currentY = margin;

        // Helper function to add text and handle page breaks
        const addText = (text: string | string[], x: number, y: number, options = {}) => {
            doc.text(text, x, y, options);
            // Basic handling, may need adjustment based on font size
            const textHeight = Array.isArray(text) ? (doc.getLineHeight() / doc.internal.scaleFactor * text.length) : (doc.getLineHeight() / doc.internal.scaleFactor);
             // Rough estimate, refine if needed
            currentY = y + textHeight + 2;
            if (currentY > pageHeight - margin) {
                doc.addPage();
                currentY = margin;
            }
            return currentY; // Return the updated Y position
        };

        // --- PDF Content ---
        doc.setFontSize(18);
        doc.setFont('helvetica', 'bold'); 
        currentY = addText('Feedback Analysis Report', pageWidth / 2, currentY, { align: 'center' });
        
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        currentY = addText(`Run ID: ${runId}`, pageWidth / 2, currentY, { align: 'center' });
        currentY = addText(`Generated: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`, pageWidth / 2, currentY, { align: 'center' });
        currentY += 5; // Add extra space

        // --- AI Summary --- 
        if (aiSummary) {
            doc.setFontSize(14);
            doc.setFont('helvetica', 'bold');
            currentY = addText('AI Summary', margin, currentY);
            currentY -= 2; // Reduce space before summary text
            
            doc.setFontSize(10);
            doc.setFont('helvetica', 'normal');
            // Split summary text to handle wrapping
            // Replace markdown bold with something simple or strip it
            const cleanedSummary = aiSummary.replace(/\*\*/g, ''); // Remove bold markers for now
            const summaryLines = doc.splitTextToSize(cleanedSummary, maxLineWidth);
            currentY = addText(summaryLines, margin, currentY);
            currentY += 5; // Add extra space
        }

        // --- Detailed Analysis --- 
        if (groupedStats && Object.keys(groupedStats).length > 0) {
            doc.setFontSize(14);
            doc.setFont('helvetica', 'bold');
            currentY = addText('Detailed Analysis by Question', margin, currentY);
             currentY += 2; // Space before first question

            Object.entries(groupedStats).forEach(([question, topics]) => {
                 if (currentY > pageHeight - margin - 20) { // Check space before adding question
                    doc.addPage();
                    currentY = margin;
                 }
                 doc.setFontSize(12);
                 doc.setFont('helvetica', 'bold');
                 currentY = addText(`Q: ${question}`, margin, currentY);
                 
                 Object.entries(topics).sort().forEach(([topic, sentiments]) => {
                    if (currentY > pageHeight - margin - 15) { doc.addPage(); currentY = margin; } // Check space
                    doc.setFontSize(11);
                    doc.setFont('helvetica', 'bold');
                    currentY = addText(`  Topic: ${topic.replace(/_/g, ' ')}`, margin + 5, currentY);
                    
                    // Iterate through fixed order to potentially show empty sections if needed?
                    // Or stick to only showing sentiments with data?
                    // Let's show only sentiments with data for simplicity now.
                    const presentSentimentsWithData = SENTIMENT_ORDER.filter(sentiment => 
                        sentiments[sentiment] && Object.keys(sentiments[sentiment]).length > 0
                    );

                    presentSentimentsWithData.forEach((sentiment) => {
                         if (currentY > pageHeight - margin - 10) { doc.addPage(); currentY = margin; } // Check space
                         const subCategories = sentiments[sentiment];
                         const headerText = sentiment === 'n/a' ? 'Responses:' : `${sentiment.charAt(0).toUpperCase() + sentiment.slice(1)}:`;
                         doc.setFontSize(10);
                         doc.setFont('helvetica', 'bold');
                         currentY = addText(`    ${headerText}`, margin + 10, currentY);
                         
                         doc.setFont('helvetica', 'normal');
                         Object.entries(subCategories)
                            .sort(([, countA], [, countB]) => countB - countA)
                            .forEach(([subCategory, count]) => {
                                if (currentY > pageHeight - margin - 5) { doc.addPage(); currentY = margin; } // Check space
                                const textLine = `      - ${subCategory}: (${count})`;
                                currentY = addText(textLine, margin + 15, currentY);
                            });
                    });
                    currentY += 3; // Space between topics
                 });
                 currentY += 5; // Space between questions
            });
        }

        // --- Save PDF --- 
        doc.save(`feedback_report_${runId}.pdf`);
        setStatusMessage('PDF report downloaded successfully.');
        setIsError(false);

    } catch (error) {
        console.error('Error generating PDF:', error);
        setStatusMessage(`Error generating PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
        setIsError(true);
    } finally {
        if(downloadButton) downloadButton.disabled = false;
    }
  };

  // --- Download Handler for Live Overview XLSX ---
  const handleDownloadLiveOverviewXlsx = () => {
    if (!liveResults || liveResults.size === 0 || !proposedMapping || !runId) {
        setStatusMessage('No live overview data available to download.');
        setIsError(true);
        return;
    }
    
    setStatusMessage('Preparing live overview XLSX...');
    setIsError(false);

    try {
        // 1. Prepare Headers
        const headers = [proposedMapping.studentIdHeader, ...proposedMapping.questionHeaders.map(qInfo => qInfo.header)];

        // 2. Format Data
        const dataForSheet = Array.from(liveResults.entries()).map(([respondentId, categories]) => {
            // Create an object for the row respecting the header order implicitly via json_to_sheet
            const row: { [key: string]: any } = { [proposedMapping.studentIdHeader]: respondentId };
            proposedMapping.questionHeaders.forEach(qInfo => {
                row[qInfo.header] = categories[qInfo.header] || ''; // Use empty string for missing categories
            });
            return row;
        });

        // 3. Create Worksheet & Workbook
        const ws = XLSX.utils.json_to_sheet(dataForSheet, { header: headers }); // Pass headers explicitely if order matters strictly
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Live Categorization');

        // 4. Trigger Download
        XLSX.writeFile(wb, `live_categorization_overview_${runId}.xlsx`);

        setStatusMessage('Live Overview XLSX downloaded successfully.');
        setIsError(false);
    } catch (error) {
        console.error('Error generating Live Overview XLSX:', error);
        setStatusMessage(`Error generating XLSX: ${error instanceof Error ? error.message : 'Unknown error'}`);
        setIsError(true);
    }
  };

  // Helper to create a button to start over
  const StartOverButton = () => (
      <button 
        onClick={handleCancel} // Use the cancel handler to reset everything
        className="inline-flex justify-center py-2 px-5 border border-gray-300 rounded-lg shadow-sm bg-white text-sm font-medium text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
      >
        Analyze Another File
      </button>
  );

  // <<< MODIFICATION START: Fetch detailed results on completion >>>
  useEffect(() => {
    // Fetch detailed data when process completes and we have a runId
    if (stage === 'complete' && runId && !detailedCategorizations) {
      const fetchDetailedResults = async () => {
        console.log('Fetching detailed results for modal...');
        try {
          // Use existing API endpoint
          const response = await fetch(`/api/get-results?runId=${runId}`);
          if (!response.ok) {
            throw new Error(`Failed to fetch detailed results: ${response.statusText}`);
          }
          const fullResults = await response.json();
          if (fullResults && Array.isArray(fullResults.categorizations)) {
            setDetailedCategorizations(fullResults.categorizations);
            console.log('Detailed results fetched successfully.');
          } else {
            throw new Error('Invalid data format received for detailed results.');
          }
        } catch (error) {
          console.error('Error fetching detailed results:', error);
          // Optionally show error to user
          setStatusMessage(`Error loading detailed comments: ${error instanceof Error ? error.message : 'Unknown error'}`);
          setIsError(true);
        }
      };
      fetchDetailedResults();
    }
    // Reset detailed data if we navigate away from complete stage or change runId
    if (stage !== 'complete' || !runId) {
         setDetailedCategorizations(null);
    }
  }, [stage, runId, detailedCategorizations]); // Add dependencies
  // <<< MODIFICATION END >>>

  // <<< MODIFICATION START: useEffect to process statsData into groupedStats >>>
  useEffect(() => {
    if (statsData) {
      console.log('Processing statsData into grouped structure...');
      const newGroupedStats: GroupedQuestionStats = {};

      Object.entries(statsData).forEach(([question, categoryCounts]) => {
        if (!newGroupedStats[question]) {
          newGroupedStats[question] = {};
        }

        Object.entries(categoryCounts).forEach(([combinedCategory, count]) => {
          const { topic, sentiment, subCategory } = parseCombinedCategory(combinedCategory);
          const subCatKey = subCategory || SUB_CATEGORY_DEFAULT.replace(/_/g, ' '); // Use display name for key?
          
          if (topic !== 'N/A' && sentiment !== 'N/A') {
              if (!newGroupedStats[question][topic]) {
                  newGroupedStats[question][topic] = {};
              }
              if (!newGroupedStats[question][topic][sentiment]) {
                  newGroupedStats[question][topic][sentiment] = {};
              }
              newGroupedStats[question][topic][sentiment][subCatKey] = count;
          }
        });
      });

      console.log('Grouped stats structure created:', newGroupedStats);
      setGroupedStats(newGroupedStats);
    } else {
      setGroupedStats(null); // Clear if statsData is cleared
    }
  }, [statsData]); // Re-run when statsData changes
  // <<< MODIFICATION END >>>

  // Click Handler for Category Summary 
  const handleCategoryClick = (question: string, combinedCategory: string) => {
    if (!detailedCategorizations) {
      console.warn('Detailed categorizations not loaded yet.');
      // Show a temporary message?
      setStatusMessage('Loading comments...');
      setIsError(false);
      return;
    }

    console.log(`Filtering for: Q="${question}", Cat="${combinedCategory}"`);

    // <<< MODIFICATION START: Filter using 3-part key logic >>>
    const commentsWithIds = detailedCategorizations
      .filter(item => {
        if (item.question_text !== question) return false;
        // Reconstruct the key from the detailed item, using default for sub_category
        const itemKey = `${item.topic}_${item.sentiment}_${item.sub_category || SUB_CATEGORY_DEFAULT}`;
        // Check if reconstructed key matches the clicked combinedCategory key
        return itemKey === combinedCategory && item.original_answer;
      })
      .map(item => ({ 
          id: item.student_identifier as string,
          comment: item.original_answer as string 
      }));
    // <<< MODIFICATION END >>>

    console.log('Found comments:', commentsWithIds);
    
    // <<< MODIFICATION START: Use helper function for modal title >>>
    const { topic, sentiment, subCategory } = parseCombinedCategory(combinedCategory);
    let modalCatTitle = `${topic} (${sentiment})`;
    if (subCategory) {
        modalCatTitle += ` - ${subCategory}`;
    }
    setModalTitle(`Comments for "${question}" | Category: ${modalCatTitle}`);
    // <<< MODIFICATION END >>>

    setModalComments(commentsWithIds.length > 0 ? commentsWithIds : [{ id: 'System', comment: 'No specific comments found for this category.' }]);
    setModalOpen(true);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4 sm:p-12 bg-gray-100 font-sans text-gray-900 overflow-hidden">
      {/* Change position to fixed and add z-index */}
      <div className="fixed top-4 left-4 sm:top-6 sm:left-6 z-50">
        <img 
          src="/slu-2-centered-blue-rgb.png" 
          alt="Saint Louis University Logo" 
          className="h-24 sm:h-26 w-auto" // Adjust size as needed
        />
      </div>
      <div className="w-full max-w-4xl p-6 sm:p-8 space-y-6 bg-white rounded-xl shadow-xl border border-gray-200 relative mt-16 sm:mt-20"> {/* Add margin-top to prevent overlap */} 
        <h1 className="text-2xl sm:text-3xl font-bold text-center text-gray-800 tracking-tight pt-8 sm:pt-4">Feedback Analyzer</h1>

        <AnimatePresence mode="wait">
          {stage === 'upload' && (
            <motion.div
              key="upload-stage"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: "easeInOut" }}
            >
              <form onSubmit={handleSubmitForMapping} className="space-y-5 max-w-xl mx-auto">
                <div>
                  <label htmlFor="file-upload" className="block text-sm font-medium text-gray-600 mb-1.5">
                    Upload Feedback File
                  </label>
                  <input 
                    id="file-upload"
                    name="file"
                    type="file"
                    accept=".xlsx, .xls, application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={handleFileChange}
                    className="block w-full text-sm text-gray-700 border border-gray-300 rounded-lg cursor-pointer focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200 disabled:opacity-50 disabled:pointer-events-none bg-white placeholder-gray-500"
                    disabled={isLoading}
                  />
                </div>
                <button 
                  type="submit"
                  disabled={isLoading || !file}
                  className="w-full flex items-center justify-center py-2.5 px-4 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  {isLoading ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-gray-700" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Analyzing Headers...
                    </>
                  ) : 'Upload & Analyze Headers'}
                </button>
              </form>
            </motion.div>
          )}

          {stage === 'confirm' && proposedMapping && (
            <motion.div
              key="confirm-stage"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: "easeInOut" }}
            >
              <div className="space-y-5 max-w-xl mx-auto">
                <h2 className="text-xl font-semibold text-gray-800">Confirm Column Mapping</h2>
                <div className="p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-3 font-mono">
                  <div>
                    <p className="text-sm font-medium text-gray-600">Respondent/Source Identifier:</p>
                    <p className="text-base font-medium text-amber-900 bg-amber-100 px-2 py-1 rounded inline-block mt-1">
                      {proposedMapping.studentIdHeader}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-600">Question Columns:</p>
                    <ul className="list-none pl-0 mt-1 space-y-1">
                      {proposedMapping.questionHeaders.map((qInfo, index) => (
                        <li key={index} className="text-sm text-gray-700 border border-gray-200 bg-white px-2 py-1 rounded">
                          {qInfo.header}
          </li>
                      ))}
                    </ul>
                  </div>
                </div>
                <p className="text-xs text-gray-500">Verify the mapping. If correct, proceed.</p>
                <div className="flex flex-col sm:flex-row gap-3 pt-2">
                  <button 
                    onClick={handleCancel}
                    disabled={isLoading}
                    className="flex-1 inline-flex justify-center py-2 px-4 border border-gray-300 rounded-lg shadow-sm bg-white text-sm font-medium text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1 disabled:opacity-50 transition-colors duration-150"
                  >
                    Cancel / New File
                  </button>
                  <button 
                    onClick={handleConfirmMapping}
                    disabled={isLoading}
                    className="flex-1 inline-flex items-center justify-center py-2 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-gray-800 hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
                  >
                    {isLoading ? 'Processing...' : 'Confirm & Proceed'}
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {stage === 'processing' && proposedMapping && rowsData && (
            <motion.div
              key="processing-stage"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: "easeInOut" }}
              className="space-y-6 w-full flex flex-col items-center justify-center py-6"
            >
               <div className="flex flex-col items-center space-y-3 mb-6">
                    <svg className="h-12 w-12 text-amber-500 animate-pulse" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
                    </svg>
                    <h2 className="text-lg font-semibold text-gray-700 animate-pulse">Analyzing Feedback...</h2>
               </div>
              <div className="w-full space-y-6">
                  <div>
                      <h3 className="text-base font-medium text-gray-600 mb-2 text-center">Input Data (Processing...)</h3>
                      <div className="overflow-x-auto max-h-[30vh] relative border border-gray-200 rounded-lg opacity-70 shadow-sm">
                         <table className="min-w-full divide-y divide-gray-200 text-sm font-mono">
                           <thead className="bg-gray-50 sticky top-0 z-10">
                             <tr>
                               <th scope="col" className="px-4 py-2 text-left font-medium text-gray-500 tracking-wider sticky left-0 bg-gray-50 z-20 w-32 sm:w-40">
                                 {proposedMapping.studentIdHeader} 
                               </th>
                               {proposedMapping?.questionHeaders?.map((qInfo) => (
                                 <th key={qInfo.header} scope="col" className="px-4 py-2 text-left font-medium text-gray-500 tracking-wider whitespace-nowrap">
                                   {qInfo.header}
                                 </th>
                               ))}
                             </tr>
                           </thead>
                           <tbody className="bg-white divide-y divide-gray-200">
                             {rowsData.map((row: any, rowIndex) => {
                                const currentBatchStart = highlightedBatchIndex * BATCH_SIZE;
                                const isHighlighted = highlightedBatchIndex !== -1 && rowIndex >= currentBatchStart && rowIndex < currentBatchStart + BATCH_SIZE;
                                return (
                                  <tr 
                                    key={rowIndex} 
                                    className={`transition-colors duration-300 ease-in-out ${isHighlighted ? 'bg-amber-50' : 'hover:bg-gray-50'}`}>
                                     <td className={`px-4 py-2 font-medium text-gray-800 whitespace-nowrap sticky left-0 z-10 w-32 sm:w-40 ${isHighlighted ? 'bg-amber-50' : 'bg-white'}`}>
                                       {row[proposedMapping.studentIdHeader] ?? 'N/A'}
                                     </td>
                                     {proposedMapping?.questionHeaders?.map((qInfo) => (
                                       <td key={qInfo.header} className="px-4 py-2 text-gray-600 whitespace-normal max-w-xs">
                                         {String(row[qInfo.header] ?? '')}
                                       </td>
                                     ))}
                                  </tr>
                                );
                             })}
                           </tbody>
                         </table>
                       </div>
                   </div>
                  <div className="pt-2 w-full">
                     <h3 className="text-base font-medium text-gray-600 mb-2 text-center">Live Categorization Results:</h3>
                     {(liveResults.size === 0 && isLoading) && (
                        <div className="p-4 border border-dashed border-gray-300 rounded-lg text-center text-gray-500">
                            Waiting for results...
                        </div>
                     )}
                     {liveResults.size > 0 && (
                        <div className="overflow-x-auto max-h-[30vh] relative border border-gray-200 rounded-lg shadow-sm">
                            <table className="min-w-full divide-y divide-gray-200 text-sm font-mono">
                                <thead className="bg-gray-50 sticky top-0 z-10">
                                    <tr>
                                        <th scope="col" className="px-4 py-2 text-left font-medium text-gray-500 tracking-wider sticky left-0 bg-gray-50 z-20 w-32 sm:w-40">Respondent</th>
                                        {proposedMapping?.questionHeaders?.map((qInfo) => (
                                             <th key={qInfo.header} scope="col" className="px-4 py-2 text-left font-medium text-gray-500 tracking-wider whitespace-nowrap">
                                                 {qInfo.header}
                                             </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                    <AnimatePresence>
                                        {Array.from(liveResults.entries()).map(([respondentId, categories]) => (
                                            <motion.tr 
                                                key={respondentId}
                                                className="hover:bg-gray-50"
                                                initial={{ opacity: 0 }}
                                                animate={{ opacity: 1 }}
                                                exit={{ opacity: 0 }}
                                                transition={{ duration: 0.3 }}
                                            >
                                                <td className="px-4 py-2 font-medium text-gray-800 whitespace-nowrap sticky left-0 bg-white z-10 w-32 sm:w-40">{respondentId}</td>
                                                {proposedMapping?.questionHeaders?.map((qInfo) => (
                                                    <td key={qInfo.header} className="px-4 py-2 text-gray-600 font-medium whitespace-normal max-w-xs">
                                                        {categories[qInfo.header] || <span className="text-xs italic text-gray-400">...</span>}
                                                    </td>
                                                ))}
                                            </motion.tr>
                                        ))}
                                    </AnimatePresence>
                                </tbody>
                            </table>
                        </div>
                     )}
                  </div>
                </div>
            </motion.div>
          )}

          {stage === 'complete' && !isError && (
               <motion.div
                 key="complete-stage"
                 initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}
                 className="space-y-8 w-full mt-2"
               >
                   <p className="text-sm text-center text-gray-500">(Processing Completed Successfully)</p>
                 
                   {/* --- AI Summary Section --- */}
                   {aiSummary && (
                       <div className="p-4 border border-blue-200 rounded-lg bg-blue-50 shadow-sm">
                          <h3 className="text-lg font-semibold text-blue-800 mb-2">AI Summary</h3>
                          <AiSummaryDisplay summaryText={aiSummary} />
                       </div>
                   )}
                   {/* Show placeholder only in complete stage if summary hasn't arrived */}
                   {!aiSummary && stage === 'complete' && !isError && (
                        <div className="p-4 border border-dashed border-gray-300 rounded-lg text-center text-gray-500">
                           Generating AI summary...
                       </div>
                   )}
                   
                   {/* --- Detailed Analysis Section --- */}
                   {groupedStats && Object.keys(groupedStats).length > 0 ? (
                       <div className="pt-2 space-y-5">
                           <h3 className="text-xl font-semibold text-gray-800 border-b border-gray-300 pb-2 mb-4">Analysis by Question</h3>
                           {Object.entries(groupedStats).map(([question, topics]) => (
                               <div key={question} className="p-4 border border-gray-200 rounded-lg bg-white shadow-md space-y-4">
                                   <p className="text-base font-semibold text-gray-900 mb-3">{question}</p>
                                   {Object.keys(topics).length > 0 ? (
                                       Object.entries(topics).sort().map(([topic, sentiments]) => {
                                           // Determine present sentiments for this topic and sort them
                                           const presentSentiments = Object.keys(sentiments).sort((a, b) => {
                                               const indexA = SENTIMENT_ORDER.indexOf(a);
                                               const indexB = SENTIMENT_ORDER.indexOf(b);
                                               // Handle sentiments not in the predefined order (shouldn't happen ideally)
                                               if (indexA === -1) return 1;
                                               if (indexB === -1) return -1;
                                               return indexA - indexB;
                                           });

                                           // Skip rendering topic if no sentiments are present (shouldn't happen with n/a)
                                           if (presentSentiments.length === 0) return null; 

                                           return (
                                               <div key={topic} className="mt-1 pt-2 border-t border-gray-100">
                                                   <h4 className="text-sm font-semibold text-gray-700 mb-3 capitalize px-3 py-1.5 bg-gray-100 border-b border-gray-200 rounded-t-md">Topic: {topic.replace(/_/g, ' ')}</h4>
                                                   
                                                   {(() => { // Immediately invoked function expression to calculate and render
                                                       const presentSentimentsWithData = SENTIMENT_ORDER.filter(sentiment => 
                                                           sentiments[sentiment] && Object.keys(sentiments[sentiment]).length > 0
                                                       );

                                                       if (presentSentimentsWithData.length === 0) {
                                                           return <p className="text-xs text-gray-400 italic px-3 pb-2">No categorized feedback for this topic.</p>;
                                                       }

                                                       // Set grid container statically to 4 columns on medium+, let items flow
                                                       const gridColsClass = 'md:grid-cols-4'; // Always use 4 columns for the container structure

                                                       return (
                                                           <div className={`grid grid-cols-1 ${gridColsClass} gap-4`}>
                                                               {/* Iterate ONLY through sentiments that have data */}
                                                               {presentSentimentsWithData.map((sentiment) => {
                                                                   const subCategories = sentiments[sentiment]; // We know this exists and is not empty now
                                                                   // Determine styling based on sentiment (same as before)
                                                                   const bgColor = sentiment === 'positive' ? 'bg-green-50' 
                                                                                 : sentiment === 'negative' ? 'bg-red-50' 
                                                                                 : 'bg-gray-50'; 
                                                                   const borderColor = sentiment === 'positive' ? 'border-green-200' 
                                                                                     : sentiment === 'negative' ? 'border-red-200' 
                                                                                     : 'border-gray-200';
                                                                   const textColor = sentiment === 'positive' ? 'text-green-800' 
                                                                                   : sentiment === 'negative' ? 'text-red-800' 
                                                                                   : 'text-gray-700';
                                                                   const headerText = sentiment === 'n/a' ? 'Responses' : sentiment;

                                                                   return (
                                                                       <div key={sentiment} className={`p-3 border ${borderColor} rounded-lg ${bgColor} space-y-2 flex flex-col`}>
                                                                            <h5 className={`text-xs font-semibold uppercase tracking-wider ${textColor} capitalize border-b ${borderColor} pb-1 mb-2`}>{headerText}</h5>
                                                                            {/* No need for placeholder, we filtered empty ones */}
                                                                            <div className="space-y-1 flex-grow min-h-[2rem]">
                                                                                {Object.entries(subCategories)
                                                                                    .sort(([, countA], [, countB]) => countB - countA) 
                                                                                    .map(([subCategory, count]) => {
                                                                                        const originalCombinedCategory = `${topic.replace(/\s+/g, '_')}_${sentiment}_${(subCategory === SUB_CATEGORY_DEFAULT.replace(/_/g, ' ')) ? SUB_CATEGORY_DEFAULT : subCategory.replace(/\s+/g, '_')}`;
                                                                                        return (
                                                                                            <button 
                                                                                                key={subCategory}
                                                                                                onClick={() => handleCategoryClick(question, originalCombinedCategory)} 
                                                                                                disabled={!detailedCategorizations} 
                                                                                                title={detailedCategorizations ? "Click to see comments" : "Loading comments..."}
                                                                                                className={`block w-full text-left px-1.5 py-0.5 rounded hover:bg-white/60 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1 disabled:opacity-60 disabled:cursor-wait transition-colors duration-150 text-gray-800`}
                                                                                            >
                                                                                                <span className="text-sm capitalize">{subCategory}</span>:
                                                                                                <span className="ml-1.5 text-sm font-semibold text-amber-700">({count})</span>
                                                                                            </button>
                                                                                        );
                                                                                    })}
                                                                            </div>
                                                                        </div>
                                                                   );
                                                               })}
                                                           </div>
                                                       );
                                                   })()} 
                                               </div>
                                           );
                                       })
                                   ) : (
                                       <p className="text-sm text-gray-500 mt-2 pl-2">No specific topics identified for this question.</p>
                                   )}
                               </div>
                           ))}
                       </div>
                   ) : (
                       statsData && <p className="text-sm text-gray-500 mt-4 text-center">No analysis data to display.</p>
                   )}
                   {!statsData && (
                       <p className="text-sm text-gray-500 mt-4 text-center">No statistics were generated for this run.</p>
                   )}

                   {/* --- Live Categorization Overview Table (with Download Button) --- */} 
                   {liveResults.size > 0 && (
                      <div className="pt-6">
                           {/* Header and Download Button Row */} 
                           <div className="flex flex-col sm:flex-row justify-between items-center border-b border-gray-300 pb-2 mb-3">
                              <h3 className="text-xl font-semibold text-gray-800 mb-2 sm:mb-0">Live Categorization Overview</h3>
                              <button 
                                  id="download-live-xlsx-button" 
                                  onClick={handleDownloadLiveOverviewXlsx}
                                  disabled={!liveResults || liveResults.size === 0}
                                  className="inline-flex items-center justify-center py-1.5 px-3 border border-gray-300 rounded-lg shadow-sm bg-white text-xs font-medium text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                  title={(!liveResults || liveResults.size === 0) ? "No live data to download" : "Download live overview as XLSX"}
                              >
                                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 mr-1.5">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v4.59L7.3 9.7a.75.75 0 0 0-1.1 1.02l3.25 3.5a.75.75 0 0 0 1.1 0l3.25-3.5a.75.75 0 1 0-1.1-1.02l-1.95 2.1V6.75Z" clipRule="evenodd" />
                                  </svg>
                                  Download Overview (XLSX)
                              </button>
                           </div>
                           
                           {/* Table Wrapper */}
                           <div className="overflow-x-auto max-h-[40vh] relative border border-gray-200 rounded-lg shadow-sm">
                               <table className="min-w-full divide-y divide-gray-200 text-sm font-mono">
                                 <thead className="bg-gray-50 sticky top-0 z-10">
                                   <tr>
                                     <th scope="col" className="px-4 py-2 text-left font-medium text-gray-500 tracking-wider sticky left-0 bg-gray-50 z-20 w-32 sm:w-40">Respondent</th>
                                     {proposedMapping?.questionHeaders?.map((qInfo) => (
                                       <th key={qInfo.header} scope="col" className="px-4 py-2 text-left font-medium text-gray-500 tracking-wider whitespace-nowrap">
                                           {qInfo.header}
                                       </th>
                                     ))}
                                   </tr>
                                 </thead>
                                 <tbody className="bg-white divide-y divide-gray-200">
                                     <AnimatePresence>
                                         {Array.from(liveResults.entries()).map(([respondentId, categories]) => (
                                             <motion.tr 
                                                 key={respondentId}
                                                 className="hover:bg-gray-50"
                                                 initial={{ opacity: 0 }}
                                                 animate={{ opacity: 1 }}
                                                 exit={{ opacity: 0 }}
                                                 transition={{ duration: 0.3 }}
                                             >
                                                 <td className="px-4 py-2 font-medium text-gray-800 whitespace-nowrap sticky left-0 bg-white z-10 w-32 sm:w-40">{respondentId}</td>
                                                 {proposedMapping?.questionHeaders?.map((qInfo) => (
                                                     <td key={qInfo.header} className="px-4 py-2 text-gray-600 font-medium whitespace-normal max-w-xs">
                                                         {categories[qInfo.header] || <span className="text-xs italic text-gray-400">...</span>}
                                                     </td>
                                                 ))}
                                             </motion.tr>
                                         ))}
                                     </AnimatePresence>
                                 </tbody>
                               </table>
                           </div>
                      </div>
                   )}

                   <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-6 pb-2"> 
                       <button id="download-pdf-button" onClick={handleDownloadPdf} className="inline-flex items-center justify-center py-2 px-4 border border-gray-300 rounded-lg shadow-sm bg-white text-sm font-medium text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1">
                           <svg className="mr-2 h-4 w-4 text-gray-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                               <path strokeLinecap="round" strokeLinejoin="round" d="M12 19.5v-15m0 0l-8.25 8.25m8.25-8.25v15" />
                           </svg>
                           Download Report (PDF)
                       </button>
                       <button id="download-json-button" onClick={handleDownloadJson} className="inline-flex items-center justify-center py-2 px-4 border border-gray-300 rounded-lg shadow-sm bg-white text-sm font-medium text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1">
                           <svg className="mr-2 h-4 w-4 text-gray-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                               <path strokeLinecap="round" strokeLinejoin="round" d="M12 19.5v-15m0 0l-8.25 8.25m8.25-8.25v15" />
                           </svg>
                           Download Data (JSON)
                       </button>
                       <StartOverButton />
        </div>
               </motion.div>
            )}
        </AnimatePresence>

        {modalOpen && (
            <div className="fixed inset-0 bg-black/50 z-40 flex items-center justify-center p-4 backdrop-blur-sm">
                <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col border border-gray-200">
                    <div className="flex justify-between items-center p-4 border-b border-gray-200">
                        <h3 className="text-lg font-semibold text-gray-800">{modalTitle}</h3>
                        <button 
                            onClick={() => setModalOpen(false)}
                            className="text-gray-400 hover:text-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
                            aria-label="Close modal"
                        >
                            {/* Close Icon */} 
                        </button>
                    </div>
                    <div className="p-6 space-y-4 overflow-y-auto flex-grow font-mono">
                        {modalComments.map((item, index) => (
                             <div key={index} className="border-b border-gray-200 pb-3 last:border-b-0">
                                <p className="text-sm text-gray-800 mb-1">{item.comment}</p>
                                <p className="text-xs text-gray-500">- {item.id}</p>
                             </div>
                        ))}
                    </div>
                    <div className="p-4 border-t border-gray-200 text-right bg-gray-50">
                       <button 
                            onClick={() => setModalOpen(false)}
                            className="py-2 px-4 border border-gray-300 rounded-lg shadow-sm bg-white text-sm font-medium text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1"
                        >
                           Close
                       </button>
                    </div>
                </div>
            </div>
        )}

        <AnimatePresence>
          {statusMessage && (
             <motion.div 
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className={`mt-5 text-sm p-3 rounded-lg border shadow-sm ${isError ? 'bg-red-50 text-red-800 border-red-300' : 'bg-gray-50 text-gray-700 border-gray-200'}`}
                role={isError ? "alert" : "status"}
            >
              {statusMessage}
            </motion.div>
          )}
        </AnimatePresence>
    </div>
    </main>
  );
}
