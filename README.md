# Rorschach Rain

**Rorschach Rain** is an interactive weather visualization experiment that transforms real-time radar data into Rorschach inkblot tests. By mirroring and filtering storm cells, it creates organic, symmetrical patterns that invite interpretation.

The project features a "Cloud Analysis" mode powered by Google's Gemini Vision API, which identifies shapes in the rain and offers creative interpretations (e.g., "Dragon", "Butterfly").

## Features
- **Real-time Radar**: Fetches live precipitation data via RainViewer API.
- **Ink Blot Mode**: Mirrors and filters radar data to create Rorschach patterns.
- **Cloud Analysis**: Uses Gemini Flash to "see" shapes in the storm cells.
- **Interactive Tools**: Geo-referenced selection tool, panning, and zooming.

## Development Setup

This is a vanilla JavaScript project (no build step required).

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/dannybauman/rorschach-rain.git
    cd rorschach-rain
    ```

2.  **Serve locally**:
    You need a simple HTTP server to avoid CORS issues with local files.

    *Using Python 3:*
    ```bash
    python3 -m http.server
    ```

    *Using Node.js (http-server):*
    ```bash
    npx http-server .
    ```

3.  **Open in Browser**:
    Visit `http://localhost:8000` (or whatever port your server uses).

## API Keys
To use the "Cloud Analysis" feature, you will need a Google Gemini API Key. The app prompts for this key in the UI (it is not stored permanently).

## License
MIT License - see [LICENSE](LICENSE) file for details.
