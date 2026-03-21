"""
Flask web server for Verilog Visualizer.
Provides API endpoints for file analysis, data management, visualization export,
and server-side file system browsing.
"""

import os
import json
import io
import re
import subprocess
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory
from verilog_parser import analyze_and_save, parse_verilog_file, parse_verilog_folder, build_hierarchy
from chisel_parser import (
    parse_chisel_folder, list_scala_files, get_modules_in_file,
    detect_package, create_chisel_file, save_module_to_file, parse_chisel_file,
    is_file_editable, save_canvas_to_file
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERILOG_DATA_DIR = os.path.join(BASE_DIR, 'data', 'VerilogVisualization')
CHISEL_DATA_DIR = os.path.join(BASE_DIR, 'data', 'ChiselEdit')
DATA_DIR = VERILOG_DATA_DIR  # backward compat alias for existing Verilog endpoints
# Auto-create data directories if they don't exist
os.makedirs(VERILOG_DATA_DIR, exist_ok=True)
os.makedirs(CHISEL_DATA_DIR, exist_ok=True)
IMPORT_SCALA_PATH = os.path.join(BASE_DIR, 'import.scala')
TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'templates')
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

app = Flask(__name__, template_folder=TEMPLATE_DIR, static_folder=STATIC_DIR)
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100MB max
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # Disable static file caching during dev


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/block-design')
def block_design():
    return render_template('block_design.html')


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
        result = analyze_and_save(source_path, DATA_DIR, save_name_override=design_name)
        return jsonify({
            'success': True,
            'saved_as': result['saved_as'],
            'top_modules': result['top_modules'],
            'module_count': len(result['modules']),
            'source_files': result.get('source_files', []),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/refresh', methods=['POST'])
def refresh_design():
    """Refresh a design by re-analyzing all its source files."""
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
    source_files = old_data.get('source_files', [])

    # Check source path exists
    if not source_path or not os.path.exists(source_path):
        return jsonify({'error': f'Source path no longer exists: {source_path}'}), 404

    try:
        result = analyze_and_save(source_path, DATA_DIR, save_name_override=design_name)
        return jsonify({
            'success': True,
            'saved_as': result['saved_as'],
            'top_modules': result['top_modules'],
            'module_count': len(result['modules']),
            'source_files': result.get('source_files', []),
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


@app.route('/api/rename', methods=['POST'])
def rename_design():
    """Rename a saved design (renames the JSON file and its comment folder)."""
    data = request.get_json() or {}
    old_name = data.get('old_name', '').strip()
    new_name = data.get('new_name', '').strip()

    if not old_name or not new_name:
        return jsonify({'error': 'old_name and new_name required'}), 400

    # Basic sanitization: only allow alphanumeric, underscore, hyphen, dot
    if not re.match(r'^[\w\-.]+$', new_name):
        return jsonify({'error': 'Invalid name: only letters, digits, _ - . allowed'}), 400

    old_json = os.path.join(DATA_DIR, f"{old_name}.json")
    new_json = os.path.join(DATA_DIR, f"{new_name}.json")

    if not os.path.exists(old_json):
        return jsonify({'error': f'Design not found: {old_name}'}), 404
    if os.path.exists(new_json):
        return jsonify({'error': f'Name already in use: {new_name}'}), 409

    # Rename JSON file
    os.rename(old_json, new_json)

    # Rename comment folder if it exists
    old_comment_dir = os.path.join(DATA_DIR, old_name)
    new_comment_dir = os.path.join(DATA_DIR, new_name)
    if os.path.isdir(old_comment_dir):
        os.rename(old_comment_dir, new_comment_dir)

    return jsonify({'success': True, 'new_name': new_name})


@app.route('/api/delete/<name>', methods=['DELETE'])
def delete_design(name):
    """Delete a saved design."""
    json_path = os.path.join(DATA_DIR, f"{name}.json")
    if os.path.exists(json_path):
        os.remove(json_path)
        return jsonify({'success': True})
    return jsonify({'error': 'Not found'}), 404


@app.route('/api/save_customizations', methods=['POST'])
def save_customizations():
    """Persist UI customizations (colors, renames, comments) into the design JSON."""
    data = request.get_json()
    name = data.get('name', '')
    customizations = data.get('customizations', {})
    if not name:
        return jsonify({'error': 'name required'}), 400
    safe_name = os.path.basename(name)
    json_path = os.path.join(DATA_DIR, f"{safe_name}.json")
    if not os.path.exists(json_path):
        return jsonify({'error': 'Design not found'}), 404
    with open(json_path, 'r', encoding='utf-8') as f:
        design_data = json.load(f)
    design_data['customizations'] = customizations
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(design_data, f, ensure_ascii=False, indent=2)
    return jsonify({'success': True})


@app.route('/api/save_state', methods=['POST'])
def save_state():
    """Persist full UI state (layout, wire_waypoints, view_state, customizations) into the design JSON."""
    data = request.get_json()
    name = data.get('name', '')
    if not name:
        return jsonify({'error': 'name required'}), 400
    safe_name = os.path.basename(name)
    json_path = os.path.join(DATA_DIR, f"{safe_name}.json")
    if not os.path.exists(json_path):
        return jsonify({'error': 'Design not found'}), 404
    with open(json_path, 'r', encoding='utf-8') as f:
        design_data = json.load(f)
    for key in ('layout', 'wire_waypoints', 'view_state', 'customizations', 'tree_expanded'):
        if key in data:
            design_data[key] = data[key]
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(design_data, f, ensure_ascii=False, indent=2)
    return jsonify({'success': True})


@app.route('/api/save_comment', methods=['POST'])
def save_comment():
    """Save a module comment (.md) file under data/<design_name>/<inst_name>.md."""
    data = request.get_json()
    design_name = data.get('design_name', '')
    inst_name = data.get('inst_name', '')
    content = data.get('content', '')

    if not design_name or not inst_name:
        return jsonify({'error': 'design_name and inst_name required'}), 400

    # Sanitize names to safe filenames
    safe_design = os.path.basename(design_name)
    safe_inst = os.path.basename(inst_name).replace('/', '_').replace('\\', '_')

    comment_dir = os.path.join(DATA_DIR, safe_design)
    os.makedirs(comment_dir, exist_ok=True)
    out_path = os.path.join(comment_dir, f"{safe_inst}.md")

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(content)

    return jsonify({'success': True, 'path': out_path})


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


# ─── Chisel / Block Design API Endpoints ─────────────────────────────────

@app.route('/api/chisel/browse', methods=['POST'])
def chisel_browse():
    """Browse filesystem for Chisel source folders. Shows directories and .scala files."""
    data = request.get_json() or {}
    path = data.get('path', os.path.expanduser('~'))
    path = os.path.expanduser(path)

    if not os.path.exists(path):
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
            is_scala = name.endswith('.scala')
            if is_dir or is_scala:
                has_scala = False
                if is_dir:
                    try:
                        has_scala = any(f.endswith('.scala')
                                       for f in os.listdir(full)
                                       if os.path.isfile(os.path.join(full, f)))
                    except PermissionError:
                        pass
                entries.append({
                    'name': name,
                    'path': full,
                    'is_dir': is_dir,
                    'is_scala': is_scala,
                    'has_scala': has_scala,
                })

        return jsonify({
            'current': os.path.abspath(path),
            'parent': os.path.dirname(os.path.abspath(path)),
            'entries': entries,
        })
    except PermissionError:
        return jsonify({'error': 'Permission denied', 'current': path, 'parent': os.path.dirname(path), 'entries': []}), 403


@app.route('/api/chisel/list_files', methods=['POST'])
def chisel_list_files():
    """List .scala files in the given folder."""
    data = request.get_json() or {}
    folder = data.get('folder', '')
    if not folder or not os.path.isdir(folder):
        return jsonify({'error': 'Invalid folder path'}), 400

    files = list_scala_files(folder)
    return jsonify({'folder': folder, 'files': files})


@app.route('/api/chisel/parse_file', methods=['POST'])
def chisel_parse_file():
    """Parse a single .scala file and return its modules."""
    data = request.get_json() or {}
    file_path = data.get('path', '')
    if not file_path or not os.path.isfile(file_path):
        return jsonify({'error': 'Invalid file path'}), 400

    modules = get_modules_in_file(file_path)
    editable = is_file_editable(file_path)
    return jsonify({'file': file_path, 'modules': modules, 'editable': editable})


@app.route('/api/chisel/parse_folder', methods=['POST'])
def chisel_parse_folder():
    """Parse all .scala files in a folder and return all modules."""
    data = request.get_json() or {}
    folder = data.get('folder', '')
    if not folder or not os.path.isdir(folder):
        return jsonify({'error': 'Invalid folder path'}), 400

    all_modules = parse_chisel_folder(folder)
    return jsonify({'folder': folder, 'modules': all_modules})


@app.route('/api/chisel/save_canvas', methods=['POST'])
def chisel_save_canvas():
    """Save canvas state (instances + wires + pins) back to the Chisel source file."""
    data = request.get_json() or {}
    file_path = data.get('file_path', '')
    module_name = data.get('module_name', '')
    ports = data.get('ports', [])
    instances = data.get('instances', [])
    wires = data.get('wires', [])
    params = data.get('params', [])

    if not file_path or not os.path.isfile(file_path):
        return jsonify({'error': 'Invalid file path'}), 400
    if not module_name:
        return jsonify({'error': 'Module name required'}), 400
    if not re.match(r'^[A-Za-z_]\w*$', module_name):
        return jsonify({'error': 'Invalid module name'}), 400
    if not is_file_editable(file_path):
        return jsonify({'error': '文件缺少 // editable 标记，不可编辑'}), 403

    # Gather port info for all modules (for wire direction resolution)
    folder = os.path.dirname(file_path)
    all_mods = parse_chisel_folder(folder)
    all_modules_ports = {n: m['ports'] for n, m in all_mods.items()}

    try:
        save_canvas_to_file(file_path, module_name, ports, instances, wires, all_modules_ports, params=params)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chisel/create_file', methods=['POST'])
def chisel_create_file():
    """Create a new .scala file with package and imports."""
    data = request.get_json() or {}
    folder = data.get('folder', '')
    file_name = data.get('file_name', '')

    if not folder or not os.path.isdir(folder):
        return jsonify({'error': 'Invalid folder path'}), 400
    if not file_name:
        return jsonify({'error': 'File name required'}), 400

    # Sanitize file name
    safe_name = os.path.basename(file_name)
    if not safe_name:
        return jsonify({'error': 'Invalid file name'}), 400

    try:
        path = create_chisel_file(folder, safe_name, IMPORT_SCALA_PATH)
        # Auto-create a default module named after the file
        default_module = ''
        base = os.path.splitext(os.path.basename(safe_name))[0]
        if base and base[0].isalpha():
            default_module = base[0].upper() + base[1:]
            try:
                save_module_to_file(path, default_module, [])
            except Exception:
                default_module = ''
        return jsonify({'success': True, 'path': path, 'name': os.path.basename(path), 'default_module': default_module})
    except FileExistsError as e:
        return jsonify({'error': str(e)}), 409
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chisel/save_module', methods=['POST'])
def chisel_save_module():
    """Save/update a module definition in a .scala file."""
    data = request.get_json() or {}
    file_path = data.get('file_path', '')
    module_name = data.get('module_name', '')
    ports = data.get('ports', [])

    if not file_path or not os.path.isfile(file_path):
        return jsonify({'error': 'Invalid file path'}), 400
    if not module_name:
        return jsonify({'error': 'Module name required'}), 400

    # Validate module_name is a valid identifier
    if not re.match(r'^[A-Za-z_]\w*$', module_name):
        return jsonify({'error': 'Invalid module name'}), 400

    try:
        save_module_to_file(file_path, module_name, ports)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chisel/read_file', methods=['POST'])
def chisel_read_file():
    """Read the content of a .scala file."""
    data = request.get_json() or {}
    file_path = data.get('path', '')
    if not file_path or not os.path.isfile(file_path):
        return jsonify({'error': 'Invalid file path'}), 400
    if not file_path.endswith('.scala'):
        return jsonify({'error': 'Not a .scala file'}), 400

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    return jsonify({'path': file_path, 'content': content})


# ─── Chisel Block Design State Persistence ──────────────────────────────

@app.route('/api/chisel/designs')
def chisel_list_designs():
    """List all saved Chisel block design states."""
    os.makedirs(CHISEL_DATA_DIR, exist_ok=True)
    designs = []
    for fname in sorted(os.listdir(CHISEL_DATA_DIR)):
        if fname.endswith('.json'):
            name = fname[:-5]
            json_path = os.path.join(CHISEL_DATA_DIR, fname)
            try:
                with open(json_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                designs.append({
                    'name': name,
                    'folder': data.get('folder', ''),
                    'module_count': len(data.get('canvasData', {})),
                })
            except Exception:
                designs.append({'name': name, 'folder': '', 'module_count': 0})
    return jsonify(designs)


@app.route('/api/chisel/design/<name>')
def chisel_get_design(name):
    """Get a specific Chisel block design state."""
    safe_name = os.path.basename(name)
    json_path = os.path.join(CHISEL_DATA_DIR, f"{safe_name}.json")
    if not os.path.exists(json_path):
        return jsonify({'error': 'Design not found'}), 404
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return jsonify(data)


@app.route('/api/chisel/save_design_state', methods=['POST'])
def chisel_save_design_state():
    """Save full Chisel block design state (canvas, customizations, layout) to server JSON."""
    data = request.get_json()
    name = data.get('name', '')
    if not name:
        return jsonify({'error': 'name required'}), 400

    safe_name = os.path.basename(name)
    if not re.match(r'^[\w\-.\u4e00-\u9fff]+$', safe_name):
        return jsonify({'error': 'Invalid name'}), 400

    os.makedirs(CHISEL_DATA_DIR, exist_ok=True)
    json_path = os.path.join(CHISEL_DATA_DIR, f"{safe_name}.json")

    # Merge with existing data if present
    existing = {}
    if os.path.exists(json_path):
        try:
            with open(json_path, 'r', encoding='utf-8') as f:
                existing = json.load(f)
        except Exception:
            pass

    for key in ('folder', 'selectedFile', 'canvasData', 'customizations',
                'nextInstanceId', 'nextWireId'):
        if key in data:
            existing[key] = data[key]

    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)
    return jsonify({'success': True})


@app.route('/api/chisel/delete_design/<name>', methods=['DELETE'])
def chisel_delete_design(name):
    """Delete a saved Chisel block design state."""
    safe_name = os.path.basename(name)
    json_path = os.path.join(CHISEL_DATA_DIR, f"{safe_name}.json")
    if os.path.exists(json_path):
        os.remove(json_path)
        return jsonify({'success': True})
    return jsonify({'error': 'Not found'}), 404


def _migrate_data_dir():
    """Migrate old flat data/ JSON files into data/VerilogVisualization/."""
    old_data = os.path.join(BASE_DIR, 'data')
    if not os.path.isdir(old_data):
        return
    for fname in os.listdir(old_data):
        full = os.path.join(old_data, fname)
        if fname.endswith('.json') and os.path.isfile(full):
            dest = os.path.join(VERILOG_DATA_DIR, fname)
            if not os.path.exists(dest):
                os.rename(full, dest)
                print(f"  migrated {fname} → data/VerilogVisualization/")
        elif os.path.isdir(full) and fname not in ('VerilogVisualization', 'ChiselEdit'):
            # Comment subfolder — move it
            dest = os.path.join(VERILOG_DATA_DIR, fname)
            if not os.path.exists(dest):
                os.rename(full, dest)
                print(f"  migrated {fname}/ → data/VerilogVisualization/")


if __name__ == '__main__':
    os.makedirs(VERILOG_DATA_DIR, exist_ok=True)
    os.makedirs(CHISEL_DATA_DIR, exist_ok=True)
    _migrate_data_dir()
    host = os.environ.get('VV_HOST', '127.0.0.1')
    port = int(os.environ.get('VV_PORT', 5000))
    print(f"Verilog data: {VERILOG_DATA_DIR}")
    print(f"Chisel data:  {CHISEL_DATA_DIR}")
    print(f"Starting Verilog Visualizer on http://{host}:{port}")
    app.run(host=host, port=port, debug=True)
