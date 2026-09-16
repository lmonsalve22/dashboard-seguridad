import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Save, Printer, RefreshCw, X, Copy, RotateCcw } from 'lucide-react';
import { persistPreferences, type PageSettings } from '../services/persistPreferences';
import { toJpeg } from 'html-to-image';
import jsPDF from 'jspdf';
import { usePrintPreferences, PrintPreferencesProvider } from '../context/PrintPreferencesContext';
import { PrintContainer } from '../components/Layout/PrintContainer';
import { PrintPreferencesContext } from '../context/PrintPreferencesContext';
import { REPORT_PAGES } from '../config/reportPages';
import { useDataFetcher } from '../hooks/useDataFetcher';
import { DashboardProvider } from '../context/DashboardContext';
import type { DashboardContextType } from '../context/DashboardContext';

const PrintWizardContent: React.FC = () => {
    const navigate = useNavigate();

    // 1. Core State
    const [pages, setPages] = useState(REPORT_PAGES);
    const [currentStep, setCurrentStep] = useState(0);

    // 2. Context & Derived State
    const { getSettings, updateSettings, hasSavedSettings, setAllSettings } = usePrintPreferences();
    const isDownloadScreen = currentStep >= pages.length;
    const currentPage = pages[currentStep];
    // Fallback settings to prevent crash on download screen
    const settings = currentPage ? getSettings(currentPage.id) : { orientation: 'portrait' as const, fitToPage: false, scale: 1, maximize: false };

    // Constants
    const PIXELS_PER_MM = 3.7795; // Standard approx for web
    const isLandscape = settings.orientation === 'landscape';
    const PAGE_HEIGHT_MM = isLandscape ? 210 : 297;
    const PAGE_HEIGHT_PX = PAGE_HEIGHT_MM * PIXELS_PER_MM;

    // 3. UI State
    const [capturedImages, setCapturedImages] = useState<Record<string, string>>({});
    const [isCapturing, setIsCapturing] = useState(false);
    const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
    const [scale, setScale] = useState(0.8);
    const [refreshKey, setRefreshKey] = useState(0);
    const [forceRenderState, setForceRenderState] = useState<'idle' | 'asking' | 'reloading'>('idle');
    // Removed local contentScale, derived from settings now
    const contentScale = settings.scale || 1;



    // 4. Refs
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const fitTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // 5. Callbacks
    const fitContentToPage = React.useCallback(() => {
        // Clear existing timeout to debounce
        if (fitTimeoutRef.current) {
            clearTimeout(fitTimeoutRef.current);
        }

        // Wait for render cycle
        fitTimeoutRef.current = setTimeout(() => {
            if (!contentRef.current || !currentPage) return;

            const isLandscape = settings.orientation === 'landscape';
            const A4_HEIGHT_PX = (isLandscape ? 210 : 297) * PIXELS_PER_MM;
            const SAFE_HEIGHT = A4_HEIGHT_PX - 80;

            // Measure height
            // We use getBoundingClientRect() which returns the VISUAL height (scaled).
            // We divide by current applied scale to get the "true" unscaled height.
            // This is often more robust than scrollHeight in heavily nested/zoomed contexts.
            const currentAppliedScale = settings.scale || 1;
            const clientHeight = contentRef.current.getBoundingClientRect().height;
            const unscaledHeight = clientHeight / currentAppliedScale;

            // Fallback to scrollHeight if clientHeight seems too small (e.g. hidden)
            // or if scrollHeight is significantly larger (indicating overflow)
            const scrollHeight = contentRef.current.scrollHeight;
            const finalUnscaledHeight = Math.max(unscaledHeight, scrollHeight); // Take the larger to ensure we fit everything

            console.log(`[AutoFit] Page: ${currentPage.id}`);
            console.log(`[AutoFit] A4 Height: ${A4_HEIGHT_PX}, Safe: ${SAFE_HEIGHT}`);
            console.log(`[AutoFit] Current Scale: ${currentAppliedScale}`);
            console.log(`[AutoFit] ClientH: ${clientHeight}, Unscaled(calc): ${unscaledHeight}, ScrollH: ${scrollHeight}`);

            const newScale = SAFE_HEIGHT / finalUnscaledHeight;

            // Apply fit only if it shrinks.
            const calculatedScale = Math.min(Math.max(newScale, 0.4), 1);

            console.log(`[AutoFit] New Scale: ${calculatedScale}`);

            // Validate against current to avoid loops or unnecessary updates
            if (Math.abs(calculatedScale - currentAppliedScale) > 0.01) {
                console.log(`[AutoFit] Applying update...`);
                updateSettings(currentPage.id, { scale: calculatedScale });
            } else {
                console.log(`[AutoFit] No significant change. Skipping.`);
            }
        }, 500); // Increased delay slightly to ensure layout stability
    }, [settings.orientation, PIXELS_PER_MM, currentPage?.id, updateSettings, settings.scale]); // Added settings.scale read for calculation (but logic prevents loop via delta check)

    // fitContentToPage es un useCallback con debounce, asi que no tiene un
    // ciclo de vida propio donde cancelar su timer. Este effect se encarga de
    // que un desmontaje no deje pendiente un setTimeout que luego toca refs y
    // estado ya inexistentes.
    React.useEffect(() => () => {
        if (fitTimeoutRef.current) {
            clearTimeout(fitTimeoutRef.current);
        }
    }, []);

    const handleFit = React.useCallback((mode: 'width' | 'height') => {
        if (!containerRef.current) return;

        const container = containerRef.current;
        const { width: containerWidth, height: containerHeight } = container.getBoundingClientRect();

        const isLandscape = settings.orientation === 'landscape';
        // A4 mm to px conversion (approx 3.78 px/mm)
        // PIXELS_PER_MM is defined in component scope now
        const pageWidthPx = (isLandscape ? 297 : 210) * PIXELS_PER_MM;
        const pageHeightPx = (isLandscape ? 210 : 297) * PIXELS_PER_MM;

        const padding = 60; // Space around the paper

        let newScale = 0.5;

        if (mode === 'width') {
            newScale = (containerWidth - padding) / pageWidthPx;
        } else {
            // mode === 'height'
            newScale = (containerHeight - padding) / pageHeightPx;
        }

        setScale(Math.min(Math.max(newScale, 0.1), 3.0));
    }, [settings.orientation, PIXELS_PER_MM]);

    // 6. Effects
    // Auto-fit to HEIGHT (show full page) when orientation changes
    useEffect(() => {
        if (isDownloadScreen) return;
        const timer = setTimeout(() => handleFit('height'), 100);
        return () => clearTimeout(timer);
    }, [settings.orientation, handleFit, isDownloadScreen]);

    const [searchParams] = useSearchParams();

    // ... (existing code)

    // Ensure we start fresh and auto-load
    useEffect(() => {
        setCapturedImages({});
        setCurrentStep(0);

        const pageId = searchParams.get('pageId');
        if (pageId) {
            const specificPage = REPORT_PAGES.find(p => p.id === pageId);
            if (specificPage) {
                setPages([specificPage]);
            } else {
                setPages(REPORT_PAGES); // Fallback
            }
        } else {
            setPages(REPORT_PAGES);
        }

        // Check for saved configs and AUTO-LOAD the latest one
        const existing = persistPreferences.getConfigs();
        if (existing.length > 0) {
            console.log("Auto-loading last print configuration...", existing[0]);
            setAllSettings(existing[0].settings);
        }
    }, [setAllSettings, searchParams]);

    // Reset content scale when changing pages AND Auto-Fit
    // Reset content scale when changing pages AND Auto-Fit
    useEffect(() => {
        if (!currentPage) return;

        // Only auto-fit if we do NOT have saved settings for this page.
        // This ensures that if the user manually set it (even to 1), we respect it.
        // "Reset" button sets scale: 1, which counts as "saved".
        if (!hasSavedSettings(currentPage.id)) {
            fitContentToPage();
        }
    }, [currentStep, fitContentToPage, hasSavedSettings, currentPage?.id]);

    // Re-fit when orientation changes
    // If user changes orientation, we ALWAYS re-fit because previous scale is likely invalid for new aspect ratio
    const prevOrientation = useRef(settings.orientation);
    useEffect(() => {
        // Only run if orientation ACTUALLY changed.
        // We dependency on fitContentToPage causes this to run on scale change too, which we want to avoid.
        if (prevOrientation.current !== settings.orientation) {
            prevOrientation.current = settings.orientation;
            fitContentToPage();
        }
    }, [settings.orientation, fitContentToPage]);

    const captureCurrentPage = async (): Promise<string | null> => {
        if (!currentPage) return null;
        try {
            const elementToCapture = document.getElementById(`wizard-capture-${currentPage.id}`);

            if (!elementToCapture) {
                console.error("Capture element not found");
                return null;
            }

            // --- EXPAND SCROLLABLES FOR CAPTURE ---
            // We need to find scrolling containers and force them to show full content
            const scrollables = elementToCapture.querySelectorAll('.overflow-y-auto, .overflow-y-scroll, .overflow-auto');
            const originalStyles: { element: HTMLElement, overflow: string, height: string, maxHeight: string }[] = [];

            scrollables.forEach(node => {
                const el = node as HTMLElement;
                originalStyles.push({
                    element: el,
                    overflow: el.style.overflow,
                    height: el.style.height,
                    maxHeight: el.style.maxHeight
                });
                el.style.overflow = 'visible';
                el.style.height = 'auto';
                el.style.maxHeight = 'none';
            });

            // Wait for layout repaint
            await new Promise(resolve => setTimeout(resolve, 500));

            const dataUrl = await toJpeg(elementToCapture, {
                quality: 0.95,
                backgroundColor: '#ffffff',
                pixelRatio: 2,
                // Ensure we capture the full scroll height/width if expanded
                width: elementToCapture.scrollWidth,
                height: elementToCapture.scrollHeight,
                style: {
                    // Force the capture container itself to be fully visible
                    overflow: 'visible',
                    height: 'auto',
                    maxHeight: 'none'
                }
            });

            // --- RESTORE STYLES ---
            originalStyles.forEach(s => {
                s.element.style.overflow = s.overflow;
                s.element.style.height = s.height;
                s.element.style.maxHeight = s.maxHeight;
            });

            return dataUrl;
        } catch (error) {
            console.error("Capture failed:", error);
            return null;
        }
    };



    const handleDuplicate = async () => {
        setIsCapturing(true);
        // Capture current state before duplication
        const imgData = await captureCurrentPage();
        if (imgData) {
            setCapturedImages(prev => ({
                ...prev,
                [currentPage.id]: imgData
            }));
        }
        setIsCapturing(false);

        const timestamp = Date.now();
        const newId = `${currentPage.id}_copy_${timestamp}`;
        const newPage = {
            ...currentPage,
            id: newId,
            title: `${currentPage.title} (Copia)`
        };

        // Clone settings from current page
        const currentSettings = getSettings(currentPage.id);
        updateSettings(newId, currentSettings);

        const newPages = [...pages];
        newPages.splice(currentStep + 1, 0, newPage);
        setPages(newPages);

        // Switch to the new page
        setCurrentStep(currentStep + 1);
    };

    const handleSkip = () => {
        if (currentStep < pages.length) {
            setCurrentStep(prev => prev + 1);
        }
    };

    // Helper to slice long images
    const sliceImage = async (dataUrl: string, orientation: 'portrait' | 'landscape'): Promise<string[]> => {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const targetRatio = orientation === 'landscape' ? 210 / 297 : 297 / 210;
                const currentRatio = img.height / img.width;

                // Tolerance 5% - If it fits roughly, don't split
                if (currentRatio <= targetRatio * 1.05) {
                    resolve([dataUrl]);
                    return;
                }

                // It is long. Calculate how many pages.
                const pageHeightInPixels = Math.floor(img.width * targetRatio);
                const slices: string[] = [];
                let yOffset = 0;

                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) { resolve([dataUrl]); return; }

                canvas.width = img.width;
                canvas.height = pageHeightInPixels;

                while (yOffset < img.height) {
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);

                    const drawHeight = Math.min(pageHeightInPixels, img.height - yOffset);
                    ctx.drawImage(img, 0, yOffset, img.width, drawHeight, 0, 0, img.width, drawHeight);

                    slices.push(canvas.toDataURL('image/jpeg', 0.95)); // High quality slices
                    yOffset += pageHeightInPixels;
                }
                resolve(slices);
            };
            img.onerror = () => resolve([dataUrl]);
            img.src = dataUrl;
        });
    };

    const handleNext = async () => {
        setIsCapturing(true);

        const imgData = await captureCurrentPage();

        if (imgData) {
            const slices = await sliceImage(imgData, settings.orientation as 'portrait' | 'landscape');

            // 1. Update current page image with the first slice
            setCapturedImages(prev => ({
                ...prev,
                [currentPage.id]: slices[0]
            }));

            // 2. Handle extra slices (Multi-page split)
            const newPages = [...pages];
            // Filter out OLD parts if we are re-doing (cleanup)
            // We must do this ALWAYS, even if we now fit in 1 page, to remove previous splits
            const filteredPages = newPages.filter(p => !p.id.startsWith(`${currentPage.id}_part_`));

            if (slices.length > 1) {
                // Construct new page objects for the slices
                const generatedPages = slices.slice(1).map((slice, index) => ({
                    id: `${currentPage.id}_part_${index + 2}`,
                    title: `${currentPage.title} (Parte ${index + 2})`,
                    // Simple component to render the pre-captured slice
                    component: () => <img src={slice} className="w-full h-full object-contain bg-white" alt="Split Part" />
                }));

                // Find where to insert (after current page)
                const currentRefIndex = filteredPages.findIndex(p => p.id === currentPage.id);

                if (currentRefIndex !== -1) {
                    filteredPages.splice(currentRefIndex + 1, 0, ...generatedPages);

                    // Pre-fill the captured images for these new pages
                    setCapturedImages(prev => {
                        const updates = { ...prev, [currentPage.id]: slices[0] };
                        generatedPages.forEach((p, idx) => {
                            updates[p.id] = slices[idx + 1];
                        });
                        return updates;
                    });
                }
            }

            // Update pages state with the filtered (and potentially expanded) list
            setPages(filteredPages);

            // Move next
            setCurrentStep(prev => prev + 1);
        } else {
            alert("Error al capturar la página.");
        }

        setIsCapturing(false);
    };

    const handlePrevious = () => {
        if (currentStep > 0) {
            setCurrentStep(prev => prev - 1);
        }
    };

    const handleFinish = async () => {
        // Capture is handled by Next now, but if we are on Download screen, we just generate
        setIsGeneratingPdf(true);
        try {
            if (pages.length === 0) return;

            // Determine initial orientation from the first page
            const firstPageId = pages[0].id;
            const firstPageSettings = getSettings(firstPageId);
            const initialOrientation = firstPageSettings.orientation;

            const pdf = new jsPDF({
                unit: 'mm',
                format: 'a4',
                orientation: initialOrientation
            });

            for (let i = 0; i < pages.length; i++) {
                const page = pages[i];
                const imgData = capturedImages[page.id]; // Access by ID

                // Fallback: If we don't have the image, skip
                if (!imgData) continue;

                const pageSettings = getSettings(page.id);
                const isLandscape = pageSettings.orientation === 'landscape';
                const pageWidth = isLandscape ? 297 : 210;
                const pageHeight = isLandscape ? 210 : 297;

                if (i > 0) {
                    pdf.addPage([pageWidth, pageHeight], isLandscape ? 'landscape' : 'portrait');
                }

                // If it's the first page, jsPDF is already initialized with correct orientation
                // However, we must ensure we use the correct width/height for addImage
                pdf.addImage(imgData, 'JPEG', 0, 0, pageWidth, pageHeight);
            }

            // SAVE CONFIGURATION AUTOMATICALLY
            const currentSettingsMap: Record<string, PageSettings> = {};
            pages.forEach(p => {
                currentSettingsMap[p.id] = getSettings(p.id);
            });
            const saved = persistPreferences.saveConfig(currentSettingsMap);
            if (saved) {
                console.log("Export configuration saved for next session.");
            }

            // Generate filename based on content
            let filename = `Reporte_Completo_${new Date().toISOString().split('T')[0]}.pdf`;
            if (pages.length === 1) {
                const safeTitle = pages[0].title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                filename = `${safeTitle}_${new Date().toISOString().split('T')[0]}.pdf`;
            }

            pdf.save(filename);
            navigate('/');
        } catch (e) {
            console.error(e);
            alert("Error generando PDF final");
        } finally {
            setIsGeneratingPdf(false);
        }
    };

    const progress = Math.round(((currentStep + 1) / pages.length) * 100);

    if (isDownloadScreen) {
        return (
            <div className="min-h-screen bg-slate-100 flex flex-col font-sans items-center justify-center p-8">
                <div className="bg-white p-8 rounded-xl shadow-2xl max-w-md w-full text-center space-y-6">
                    <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                        <Printer className="w-10 h-10 text-green-600" />
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold text-slate-800">¡Todo Listo!</h2>
                        <p className="text-slate-500 mt-2">
                            Se han capturado {pages.length} páginas exitosamente.
                        </p>
                    </div>

                    <button
                        onClick={handleFinish}
                        disabled={isGeneratingPdf}
                        className="w-full py-4 bg-slate-900 text-white rounded-xl font-bold text-lg hover:bg-slate-800 transition-all shadow-lg hover:shadow-xl flex items-center justify-center space-x-2"
                    >
                        {isGeneratingPdf ? (
                            <>
                                <RefreshCw className="w-5 h-5 animate-spin" />
                                <span>Generando PDF...</span>
                            </>
                        ) : (
                            <>
                                <Save className="w-5 h-5" />
                                <span>Descargar PDF</span>
                            </>
                        )}
                    </button>

                    <button
                        onClick={() => setCurrentStep(pages.length - 1)}
                        className="text-slate-500 text-sm font-medium hover:underline"
                    >
                        Volver a revisar
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-100 flex flex-col font-sans">
            <div className="bg-slate-900 text-white p-4 shadow-md z-10 sticky top-0">
                <div className="max-w-7xl mx-auto flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                        <div className="bg-orange-600 p-2 rounded-lg">
                            <Printer className="w-6 h-6 text-white" />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold">Asistente de Exportación PDF</h1>
                            <div className="flex items-center space-x-2 text-sm text-gray-400">
                                <span>Página {currentStep + 1} de {pages.length}</span>
                                {currentPage && (
                                    <>
                                        <span>•</span>
                                        <span>{currentPage.title}</span>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center space-x-6">
                        <div className="w-64 h-2 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
                            <div
                                className="h-full bg-orange-500 transition-all duration-300 ease-out"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                        <button
                            onClick={() => navigate('/')}
                            className="p-2 hover:bg-white/10 rounded-full transition-colors"
                        >
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-hidden flex flex-col">
                <div className="flex-1 flex overflow-hidden">
                    {/* Controls Sidebar */}
                    <div className="w-80 bg-white border-r border-gray-200 flex flex-col z-20 shadow-lg shrink-0">
                        <div className="p-6 space-y-8 overflow-y-auto flex-1">
                            <div>
                                <h3 className="font-bold text-slate-800 text-lg mb-1">Configuración</h3>
                                <p className="text-slate-500 text-xs">Ajuste la vista antes de capturar.</p>
                            </div>

                            <div className="space-y-6">
                                <div>
                                    <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-3">Orientación</label>
                                    <div className="grid grid-cols-2 gap-2">
                                        <button
                                            onClick={() => updateSettings(currentPage.id, { orientation: 'portrait' })}
                                            className={`px-3 py-3 text-sm font-medium rounded-lg border transition-all ${settings.orientation === 'portrait' ? 'bg-slate-900 text-white border-slate-900 ring-2 ring-slate-900 ring-offset-2' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                                        >
                                            <div className="flex flex-col items-center gap-1">
                                                <div className="w-4 h-6 border-2 border-current rounded-sm mb-1"></div>
                                                Vertical
                                            </div>
                                        </button>
                                        <button
                                            onClick={() => updateSettings(currentPage.id, { orientation: 'landscape' })}
                                            className={`px-3 py-3 text-sm font-medium rounded-lg border transition-all ${settings.orientation === 'landscape' ? 'bg-slate-900 text-white border-slate-900 ring-2 ring-slate-900 ring-offset-2' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                                        >
                                            <div className="flex flex-col items-center gap-1">
                                                <div className="w-6 h-4 border-2 border-current rounded-sm mb-1"></div>
                                                Horizontal
                                            </div>
                                        </button>
                                    </div>
                                </div>

                                {/* Duplication of Page */}
                                <div className="pt-2">
                                    <button
                                        onClick={handleDuplicate}
                                        className="w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 font-medium transition-colors"
                                    >
                                        <Copy className="w-4 h-4" />
                                        <span>Duplicar Página Actual</span>
                                    </button>
                                    <p className="text-[10px] text-gray-400 mt-2 text-center">
                                        Utilice esto para capturar la misma página con diferentes filtros.
                                    </p>
                                </div>

                                {/* Content Scale / Fit to Page */}
                                <div className="pt-4 border-t border-gray-100">
                                    <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-3">
                                        Escala de Contenido
                                    </label>

                                    <div className="flex items-center space-x-2 mb-3">
                                        <button
                                            onClick={fitContentToPage}
                                            className="w-full py-2 bg-slate-800 text-white text-xs font-bold rounded-lg hover:bg-slate-700 transition-colors flex items-center justify-center gap-2"
                                        >
                                            <span className="text-lg leading-none">📄</span> Ajustar a 1 Página
                                        </button>

                                        <button
                                            onClick={() => updateSettings(currentPage.id, { scale: 1 })}
                                            className="p-2 bg-slate-100 text-slate-500 rounded-lg hover:bg-slate-200 transition-colors"
                                            title="Restablecer escala (100%)"
                                        >
                                            <RotateCcw className="w-4 h-4" />
                                        </button>
                                    </div>

                                    <div className="mb-4">
                                        <label className="flex items-center space-x-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={!!settings.maximize}
                                                onChange={(e) => {
                                                    updateSettings(currentPage.id, { maximize: e.target.checked });
                                                    // Trigger re-fit after a brief delay to allow render
                                                    setTimeout(fitContentToPage, 100);
                                                }}
                                                className="w-4 h-4 text-orange-600 rounded border-gray-300 focus:ring-orange-500"
                                            />
                                            <span className="text-xs text-slate-700 font-medium select-none">Maximizar espacio (Ancho/Alto)</span>
                                        </label>
                                    </div>

                                    <div className="flex items-center space-x-3">
                                        <span className="text-xs font-bold text-slate-700 w-8">{(contentScale * 100).toFixed(0)}%</span>
                                        <input
                                            type="range"
                                            min="0.4"
                                            max="1.0"
                                            step="0.05"
                                            value={contentScale}
                                            onChange={(e) => updateSettings(currentPage.id, { scale: parseFloat(e.target.value) })}
                                            className="flex-1 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-slate-900"
                                        />
                                    </div>

                                    {contentRef.current && (
                                        <div className="mt-2 text-right">
                                            <p className="text-[10px] text-gray-500">
                                                Páginas estimadas: <strong>
                                                    {Math.max(1, Math.ceil(
                                                        (contentRef.current.scrollHeight * contentScale) / PAGE_HEIGHT_PX
                                                    ))}
                                                </strong>
                                            </p>
                                            {Math.ceil((contentRef.current.scrollHeight * contentScale) / PAGE_HEIGHT_PX) > 1 && (
                                                <p className="text-[10px] text-orange-600 font-bold animate-pulse">
                                                    ⚠️ El contenido excede 1 página
                                                </p>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div className="pt-4 border-t border-gray-100">
                                    <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-3">
                                        Zoom de Vista Previa ({Math.round(scale * 100)}%)
                                    </label>

                                    <input
                                        type="range"
                                        min="0.3"
                                        max="1.5"
                                        step="0.05"
                                        value={scale}
                                        onChange={(e) => setScale(parseFloat(e.target.value))}
                                        className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-orange-600 mb-2"
                                    />
                                    <div className="flex justify-between text-xs text-gray-400">
                                        <span>Alejar</span>
                                        <span>Acercar</span>
                                    </div>
                                </div>

                                <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
                                    <p className="text-xs text-blue-700 leading-relaxed font-medium">
                                        ℹ️ El marco gris indica el área de impresión. Ajuste la orientación si el contenido se corta.
                                    </p>
                                </div>

                                {/* Interactive Force Render Button */}
                                <div>
                                    {forceRenderState === 'idle' && (
                                        <button
                                            onClick={() => {
                                                // Real initial reload
                                                setRefreshKey(p => p + 1);
                                                window.dispatchEvent(new Event('resize'));
                                                setForceRenderState('reloading');

                                                // Wait 3 seconds then ask
                                                setTimeout(() => {
                                                    setForceRenderState('asking');
                                                }, 3000);
                                            }}
                                            className="w-full flex items-center justify-center space-x-2 px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-lg transition-colors border border-dashed border-slate-300"
                                        >
                                            <RefreshCw className="w-3 h-3" />
                                            <span>¿Problemas de carga? Clic aquí</span>
                                        </button>
                                    )}

                                    {forceRenderState === 'asking' && (
                                        <div className="p-3 bg-orange-50 border border-orange-100 rounded-lg animate-in fade-in slide-in-from-top-2">
                                            <p className="text-xs font-bold text-orange-800 mb-2 text-center">¿Se cargaron correctamente los gráficos?</p>
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => setForceRenderState('idle')}
                                                    className="flex-1 py-1.5 bg-green-600 text-white text-xs font-bold rounded hover:bg-green-700"
                                                >
                                                    Sí, perfecto
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        // Fake retry for subsequent attempts
                                                        setForceRenderState('reloading');
                                                        setTimeout(() => {
                                                            setForceRenderState('asking'); // Ask again
                                                        }, 2000); // 2 second fake delay
                                                    }}
                                                    className="flex-1 py-1.5 bg-red-100 text-red-700 text-xs font-bold rounded hover:bg-red-200"
                                                >
                                                    No, reintentar
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    {forceRenderState === 'reloading' && (
                                        <div className="w-full py-3 flex items-center justify-center space-x-2 text-xs font-bold text-slate-500 bg-slate-50 rounded-lg border border-slate-100 cursor-wait">
                                            <RefreshCw className="w-3 h-3 animate-spin" />
                                            <span>
                                                {forceRenderState === 'reloading' ? 'Recargando visualización...' : 'Optimizando...'}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Page Preview Wrapper - Full Canvas Mode */}
                    {/* Page Preview Wrapper - Scale Viewport */}
                    <div ref={containerRef} className="flex-1 bg-slate-300 overflow-hidden flex items-center justify-center relative p-8">
                        <PrintContainer
                            id={`wizard-capture-${currentPage.id}`}
                            width={settings.orientation === 'landscape' ? '297mm' : '210mm'}
                            minHeight={settings.orientation === 'landscape' ? '210mm' : '297mm'}
                            minimal={true}
                            innerPadding={currentPage.id === 'communal-fact-sheet' ? 'p-0' : 'p-8'}
                            // We add explicit border and shadow to represent the "Paper"
                            className="shadow-2xl bg-white origin-center border border-gray-400"
                            style={{ transform: `scale(${scale})`, transition: 'transform 0.3s ease-out' }}
                        >
                            <div
                                className={`is-printing bg-white w-full h-full relative ${settings.maximize ? 'flex flex-col' : ''}`}
                                style={{
                                    zoom: contentScale,
                                    // Make children take full height if maximized
                                    height: settings.maximize ? '100vh' : 'auto',
                                    minHeight: '100%'
                                }}
                                ref={contentRef}
                            >
                                {/* Page Break Indicators */}
                                {contentRef.current && Array.from({ length: 5 }).map((_, i) => {
                                    const topPos = ((i + 1) * PAGE_HEIGHT_PX) / contentScale;
                                    if (topPos * contentScale >= contentRef.current!.scrollHeight * contentScale) return null;

                                    return (
                                        <div
                                            key={i}
                                            className="absolute w-full border-b-2 border-dashed border-red-400 z-50 pointer-events-none flex items-end justify-end pr-2 pb-1"
                                            style={{
                                                top: `${topPos}px`,
                                                left: 0
                                            }}
                                        >
                                            <span className="text-xs text-red-500 font-bold bg-white/80 px-1 rounded">
                                                Fin de Página {i + 1}
                                            </span>
                                        </div>
                                    );
                                })}

                                <PrintPreferencesContext.Provider value={{
                                    getSettings,
                                    updateSettings,
                                    setAllSettings: () => { },
                                    hasSavedSettings,
                                    isPrinting: true,
                                    setPrinting: () => { }
                                }}>
                                    <currentPage.component key={`${currentPage.id}-${refreshKey}`} />
                                </PrintPreferencesContext.Provider>
                            </div>
                        </PrintContainer>
                    </div>
                </div>
            </div>

            <div className="bg-white border-t border-gray-200 p-4 z-10 sticky bottom-0">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <button
                        onClick={handlePrevious}
                        disabled={currentStep === 0 || isCapturing}
                        className="flex items-center space-x-2 px-6 py-2.5 rounded-lg font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        <ChevronLeft className="w-5 h-5" />
                        <span>Anterior</span>
                    </button>
                    <div className="text-sm font-medium text-gray-500">
                        {/* Status text removed */}
                    </div>

                    <div className="flex items-center space-x-4">
                        <button
                            onClick={handleSkip}
                            disabled={isCapturing}
                            className="text-slate-500 hover:text-slate-800 text-sm font-bold underline px-2"
                        >
                            Omitir página
                        </button>

                        <button
                            onClick={handleNext}
                            disabled={isCapturing}
                            className="flex items-center space-x-2 px-8 py-2.5 rounded-lg font-bold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-70 disabled:cursor-not-allowed transition-all shadow-lg hover:shadow-xl active:scale-95"
                        >
                            <span>{currentStep === pages.length - 1 ? 'Finalizar Captura' : 'Siguiente'}</span>
                            {isCapturing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <ChevronRight className="w-5 h-5" />}
                        </button>
                    </div>
                </div >
            </div>

            {/* Load Config Modal */}

        </div >
    );
};

export const PrintWizardPage: React.FC = () => {
    const {
        leyStopData, ceadData, comunaAnalysisData,
        nationalData, historicalData, demographicsData,
        loading, error, availableComunas, maxWeek
    } = useDataFetcher();

    const [selectedComuna, setSelectedComuna] = useState<string>('');
    const [selectedWeek, setSelectedWeek] = useState<number>(0);

    // Initialize defaults similar to Layout
    useEffect(() => {
        if (maxWeek && selectedWeek === 0) setSelectedWeek(maxWeek);
    }, [maxWeek, selectedWeek]);

    useEffect(() => {
        if (availableComunas.length > 0 && !selectedComuna) {
            // Default to "Quillota" if exists, otherwise first
            const defaultComuna = availableComunas.includes('Quillota') ? 'Quillota' : availableComunas[0];
            setSelectedComuna(defaultComuna);
        }
    }, [availableComunas, selectedComuna]);

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center bg-slate-900 text-white">
                <div className="space-y-4 text-center">
                    <RefreshCw className="w-12 h-12 animate-spin mx-auto text-orange-500" />
                    <p>Cargando datos del sistema...</p>
                </div>
            </div>
        );
    }

    if (error) return <div className="p-8 text-white bg-red-600">Error: {error}</div>;

    const contextValue: DashboardContextType = {
        data: {
            leyStop: leyStopData, cead: ceadData, comunaAnalysis: comunaAnalysisData,
            national: nationalData, historical: historicalData, demographics: demographicsData
        },
        globalState: {
            selectedComuna, setSelectedComuna, availableComunas,
            year: 2025, week: maxWeek || 28, maxWeek: maxWeek || 28,
            selectedWeek: selectedWeek || 28, setSelectedWeek,
            viewState: {},
            setViewState: () => { }
        },
        loading, error
    };

    return (
        <DashboardProvider value={contextValue}>
            <PrintPreferencesProvider>
                <PrintWizardContent />
            </PrintPreferencesProvider>
        </DashboardProvider>
    );
};
