import * as imglyEngine from '@imgly/background-removal';
const processImage = imglyEngine.default || imglyEngine.removeBackground;

function sharpenAlpha(a) {
    const OPAQUE_FLOOR = 200;
    const TRANSPARENT_CEILING = 40;
    if (a >= OPAQUE_FLOOR) return 255;
    if (a <= TRANSPARENT_CEILING) return 0;
    return Math.round(((a - TRANSPARENT_CEILING) / (OPAQUE_FLOOR - TRANSPARENT_CEILING)) * 255);
}

window.removeProductBackground = async function (imageSrc, onProgress) {
    try {
        // publicPath intentionally NOT set — uses the library's own default
        // (IMG.LY's CDN, versioned to match the installed package). This is
        // what worked originally; a local override broke things because the
        // two @imgly packages had drifted to incompatible resources.json
        // schemas. Do not reintroduce a publicPath override without first
        // confirming both packages are pinned to the exact same version.
        const config = {
            model: "isnet",
            progress: (key, current, total) => {
                if (total) {
                    onProgress({ status: "progress", progress: Math.round((current / total) * 100) });
                }
            }
        };
        const cutoutBlob = await processImage(imageSrc, config);
        const cutoutUrl = URL.createObjectURL(cutoutBlob);
        let sourceImg, cutoutImg;
        try {
            [sourceImg, cutoutImg] = await Promise.all([loadImage(imageSrc), loadImage(cutoutUrl)]);
        } finally {
            URL.revokeObjectURL(cutoutUrl);
        }
        const sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = sourceImg.naturalWidth || sourceImg.width;
        sourceCanvas.height = sourceImg.naturalHeight || sourceImg.height;
        const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
        sourceCtx.drawImage(sourceImg, 0, 0, sourceCanvas.width, sourceCanvas.height);
        const sourceData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
        const alphaCanvas = document.createElement("canvas");
        alphaCanvas.width = sourceCanvas.width;
        alphaCanvas.height = sourceCanvas.height;
        const alphaCtx = alphaCanvas.getContext("2d", { willReadFrequently: true });
        alphaCtx.drawImage(cutoutImg, 0, 0, alphaCanvas.width, alphaCanvas.height);
        const alphaData = alphaCtx.getImageData(0, 0, alphaCanvas.width, alphaCanvas.height);
        const outData = sourceData.data;
        for (let i = 3; i < outData.length; i += 4) {
            outData[i] = sharpenAlpha(alphaData.data[i]);
        }
        sourceCtx.putImageData(sourceData, 0, 0);
        return sourceCanvas.toDataURL("image/png");
    } catch (error) {
        console.error("Local processing error:", error);
        throw new Error("Local extraction failed: " + error.message);
    }
};

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load image for compositing."));
        img.src = src;
    });
}