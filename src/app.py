"""
Flask web server for Verilog Visualizer.
Provides API endpoints for file analysis, data management, visualization export,
and server-side file system browsing.
"""

import os
import json
import io
import subprocess
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory
from verilog_parser import analyze_and_save, parse_verilog_file, parse_verilog_folder, build_hierarchy

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'templates')
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

app = Flask(__name__, template_folder=TEMPLATE_DIR, static_folder=STATIC_DIR)
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100MB max
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # Disable static file caching during dev


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/browse', methods=['POST'])
def browse_filesystem():
    """Browse the local filesystem. Returns directory listing."""
    data = request.get_json() or {}
    path = data.get('path', os.path.expanduser('~'))
    path = os.path.expanduser(path)

    if not os.path.exists(path):
        # Try parent
        path = os.path.dirname(path)
        if not os.path.exists(path):
            path = os.path.expanduser('~')

    if os.path.isfile(path):
        path = os.path.dirname(path)

    try:
        entries = []
        for name in sorted(os.listdir(path), key=lambda x: (not os.path.isdir(os.path.join(path, x)), x.lower())):
            if name.startswith('.'):
                continue
            full = os.path.join(path, name)
            is_dir = os.path.isdir(full)
            is_verilog = name.endswith(('.v', '.sv', '.vh'))
            # Only show directories and verilog files
            if is_dir or is_verilog:
                has_verilog = False
                if is_dir:
                    # Quick check if folder contains verilog files (1 level)
                    try:
                        has_verilog = any(f.endswith(('.v', '.sv', '.vh'))
                                         for f in os.listdir(full)
                                         if os.path.isfile(os.path.join(full, f)))
                    except PermissionError:
                        pass
                entries.append({
                    'name': name,
                    'path': full,
                    'is_dir': is_dir,
                    'is_verilog': is_verilog,
                    'has_verilog': has_verilog,
                })

        return jsonify({
            'current': os.path.abspath(path),
            'parent': os.path.dirname(os.path.abspath(path)),
            'entries': entries,
        })
    except PermissionError:
        return jsonify({'error': 'Permission denied', 'current': path, 'parent': os.path.dirname(path), 'entries': []}), 403


@app.route('/api/analyze', methods=['POST'])
def analyze():
    """Analyze a Verilog file or folder path from the local filesystem."""
    data = request.get_json()
    source_path = data.get('path', '')

    if not source_path:
        return jsonify({'error': 'No path provided'}), 400

    source_path = os.path.expanduser(source_path)
    if not os.path.exists(source_path):
        return jsonify({'error': f'Path not found: {source_path}'}), 404

    try:
        result = analyze_and_save(source_path, DATA_DIR)
        return jsonify({
            'success': True,
            'saved_as': result['saved_as'],
            'top_modules': result['top_modules'],
            'module_count': len(result['modules']),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/reload', methods=['POST'])
def reload_design():
    """Reload a previously saved design from its source path."""
    data = request.get_json()
    design_name = data.get('name', '')

    if not design_name:
        return jsonify({'error': 'No design name provided'}), 400

    json_path = os.path.join(DATA_DIR, f"{design_name}.json")
    if not os.path.exists(json_path):
        return jsonify({'error': f'Design not found: {design_name}'}), 404

    with open(json_path, 'r') as f:
        old_data = json.load(f)

    source_path = old_data.get('source_path', '')
    if not source_path or not os.path.exists(source_path):
        return jsonify({'error': f'Source path no longer exists: {source_path}'}), 404

    try:
        result = analyze_and_save(source_path, DATA_DIR)
        return jsonify({
            'success': True,
            'saved_as': result['saved_as'],
            'top_modules': result['top_modules'],
            'module_count': len(result['modules']),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/designs')
def list_designs():
    """List all saved designs in the data directory."""
    os.makedirs(DATA_DIR, exist_ok=True)
    designs = []
    for fname in sorted(os.listdir(DATA_DIR)):
        if fname.endswith('.json'):
            name = fname[:-5]
            json_path = os.path.join(DATA_DIR, fname)
            try:
                with open(json_path, 'r') as f:
                    data = json.load(f)
                designs.append({
                    'name': name,
                    'top_modules': data.get('top_modules', []),
                    'module_count': len(data.get('modules', {})),
                    'source_path': data.get('source_path', ''),
                })
            except:
                designs.append({'name': name, 'top_modules': [], 'module_count': 0, 'source_path': ''})
    return jsonify(designs)


@app.route('/api/design/<name>')
def get_design(name):
    """Get a specific design's data."""
    json_path = os.path.join(DATA_DIR, f"{name}.json")
    if not os.path.exists(json_path):
        return jsonify({'error': f'Design not found: {name}'}), 404
    with open(json_path, 'r') as f:
        data = json.load(f)
    return jsonify(data)


@app.route('/api/delete/<name>', methods=['DELETE'])
def delete_design(name):
    """Delete a saved design."""
    json_path = os.path.join(DATA_DIR, f"{name}.json")
    if os.path.exists(json_path):
        os.remove(json_path)
        return jsonify({'success': True})
    return jsonify({'error': 'Not found'}), 404


@app.route('/api/export/<name>/<fmt>')
def export_design(name, fmt):
    """Export a design in the specified format: svg, png, html."""
    json_path = os.path.join(DATA_DIR, f"{name}.json")
    if not os.path.exists(json_path):
        return jsonify({'error': 'Design not found'}), 404

    if fmt == 'json':
        return send_file(json_path, as_attachment=True, download_name=f"{name}.json")

    # For SVG/PNG/HTML, the client will handle rendering
    # This endpoint provides the data; actual rendering is done client-side
    # But we also support server-side SVG generation for download
    if fmt == 'svg':
        svg_content = request.args.get('svg', '')
        if svg_content:
            buf = io.BytesIO(svg_content.encode('utf-8'))
            buf.seek(0)
            return send_file(buf, mimetype='image/svg+xml',
                           as_attachment=True, download_name=f"{name}.svg")
        return jsonify({'error': 'SVG content required via query param'}), 400

    if fmt == 'html':
        html_content = request.args.get('html', '')
        if html_content:
            buf = io.BytesIO(html_content.encode('utf-8'))
            buf.seek(0)
            return send_file(buf, mimetype='text/html',
                           as_attachment=True, download_name=f"{name}.html")
        return jsonify({'error': 'HTML content required'}), 400

    return jsonify({'error': f'Unsupported format: {fmt}'}), 400


@app.route('/api/export_svg', methods=['POST'])
def export_svg():
    """Export SVG content sent from the client."""
    data = request.get_json()
    svg = data.get('svg', '') or data.get('svg_content', '')
    name = data.get('name', 'design')
    if not svg:
        return jsonify({'error': 'No SVG content'}), 400
    buf = io.BytesIO(svg.encode('utf-8'))
    buf.seek(0)
    return send_file(buf, mimetype='image/svg+xml',
                     as_attachment=True, download_name=f"{name}.svg")


@app.route('/api/export_html', methods=['POST'])
def export_html():
    """Export standalone HTML content."""
    data = request.get_json()
    svg = data.get('svg', '') or data.get('svg_content', '')
    name = data.get('name', 'design')
    if not svg:
        return jsonify({'error': 'No SVG content'}), 400

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>{name} - Verilog Design</title>
<style>
body {{ margin: 0; padding: 20px; background: #0d1117; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; }}
svg {{ max-width: 100%; height: auto; }}
</style>
</head>
<body>
{svg}
</body>
</html>"""

    buf = io.BytesIO(html.encode('utf-8'))
    buf.seek(0)
    return send_file(buf, mimetype='text/html',
                     as_attachment=True, download_name=f"{name}.html")


if __name__ == '__main__':
    os.makedirs(DATA_DIR, exist_ok=True)
    print(f"Data directory: {DATA_DIR}")
    print(f"Starting Verilog Visualizer on http://127.0.0.1:5000")
    app.run(host='127.0.0.1', port=5000, debug=True)
