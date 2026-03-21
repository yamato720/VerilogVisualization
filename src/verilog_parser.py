"""
Verilog Parser - Parses Verilog files to extract module hierarchy, ports, and connections.
"""

import re
import os
import json
from typing import Dict, List, Optional, Tuple


class VerilogPort:
    """Represents a port of a Verilog module."""
    def __init__(self, name: str, direction: str, width: int = 1,
                 msb: int = 0, lsb: int = 0, is_active_low: bool = False):
        self.name = name
        self.direction = direction  # 'input', 'output', 'inout'
        self.width = width
        self.msb = msb
        self.lsb = lsb
        self.is_active_low = is_active_low

    def to_dict(self):
        return {
            'name': self.name,
            'direction': self.direction,
            'width': self.width,
            'msb': self.msb,
            'lsb': self.lsb,
            'is_active_low': self.is_active_low,
        }


class VerilogInstance:
    """Represents an instantiation of a module inside another module."""
    def __init__(self, module_type: str, instance_name: str,
                 connections: Dict[str, str] = None, param_values: Dict[str, str] = None):
        self.module_type = module_type
        self.instance_name = instance_name
        self.connections = connections or {}  # port_name -> connected_signal
        self.param_values = param_values or {}

    def to_dict(self):
        return {
            'module_type': self.module_type,
            'instance_name': self.instance_name,
            'connections': self.connections,
            'param_values': self.param_values,
        }


class VerilogWire:
    """Represents a wire/reg declaration."""
    def __init__(self, name: str, width: int = 1, msb: int = 0, lsb: int = 0):
        self.name = name
        self.width = width
        self.msb = msb
        self.lsb = lsb

    def to_dict(self):
        return {
            'name': self.name,
            'width': self.width,
            'msb': self.msb,
            'lsb': self.lsb,
        }


class VerilogModule:
    """Represents a parsed Verilog module."""
    def __init__(self, name: str):
        self.name = name
        self.ports: List[VerilogPort] = []
        self.instances: List[VerilogInstance] = []
        self.wires: List[VerilogWire] = []
        self.assigns: List[Dict[str, str]] = []  # [{target, source}]
        self.parameters: Dict[str, str] = {}
        self.source_file: str = ""

    def to_dict(self):
        return {
            'name': self.name,
            'ports': [p.to_dict() for p in self.ports],
            'instances': [i.to_dict() for i in self.instances],
            'wires': [w.to_dict() for w in self.wires],
            'assigns': self.assigns,
            'parameters': self.parameters,
            'source_file': self.source_file,
        }


def _remove_comments(text: str) -> str:
    """Remove single-line and multi-line comments from Verilog source."""
    # Remove single-line comments
    text = re.sub(r'//.*?$', '', text, flags=re.MULTILINE)
    # Remove multi-line comments
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    return text


def _remove_preprocessor(text: str) -> str:
    """Remove `ifdef/`endif blocks and other preprocessor directives."""
    # Remove ifdef/ifndef/else/endif blocks (simple version - remove content between)
    # We keep the non-conditional parts
    lines = text.split('\n')
    result = []
    skip_depth = 0
    for line in lines:
        stripped = line.strip()
        if re.match(r'^`(ifdef|ifndef)\b', stripped):
            skip_depth += 1
            continue
        elif stripped == '`else':
            continue
        elif stripped == '`endif':
            if skip_depth > 0:
                skip_depth -= 1
            continue
        elif skip_depth > 0:
            continue
        elif stripped.startswith('`'):
            continue  # Skip other preprocessor directives
        result.append(line)
    return '\n'.join(result)


def _parse_width(width_str: str) -> Tuple[int, int, int]:
    """Parse a width specification like [7:0] and return (width, msb, lsb)."""
    if not width_str:
        return 1, 0, 0
    m = re.match(r'\[(\d+):(\d+)\]', width_str.strip())
    if m:
        msb = int(m.group(1))
        lsb = int(m.group(2))
        return abs(msb - lsb) + 1, msb, lsb
    return 1, 0, 0


def _detect_active_low(name: str) -> bool:
    """Detect if a port is active-low based on naming convention."""
    low_patterns = [
        r'_n$', r'_b$', r'_l$', r'_bar$',
        r'^n_', r'^n[A-Z]',
        r'_neg$', r'_inv$',
    ]
    for pat in low_patterns:
        if re.search(pat, name, re.IGNORECASE):
            return True
    return False


def parse_verilog_file(filepath: str) -> List[VerilogModule]:
    """Parse a single Verilog file and return list of modules found."""
    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        text = f.read()

    text = _remove_comments(text)
    text = _remove_preprocessor(text)

    modules = []

    # Find all module definitions
    # Pattern: module <name> ( ... ); ... endmodule
    # Also handle: module <name> #( ... ) ( ... ); ... endmodule
    module_pattern = re.compile(
        r'module\s+(\w+)\s*'          # module name
        r'(?:#\s*\(([^)]*)\)\s*)?'    # optional parameters
        r'\(([^)]*)\)\s*;'            # port list
        r'(.*?)'                       # module body
        r'endmodule',
        re.DOTALL
    )

    for m in module_pattern.finditer(text):
        mod_name = m.group(1)
        param_text = m.group(2) or ''
        port_text = m.group(3) or ''
        body_text = m.group(4) or ''

        module = VerilogModule(mod_name)
        module.source_file = os.path.basename(filepath)

        # Parse parameters from #() block
        if param_text.strip():
            param_pattern = re.compile(
                r'parameter\s+(?:\w+\s+)?(\w+)\s*=\s*([^,\)]+)'
            )
            for pm in param_pattern.finditer(param_text):
                module.parameters[pm.group(1)] = pm.group(2).strip()

        # Parse ports from the port list
        # Handle ANSI-style port declarations within the module header
        port_pattern = re.compile(
            r'(input|output|inout)\s+'
            r'(?:(wire|reg)\s+)?'
            r'(?:(signed)\s+)?'
            r'(\[\s*\d+\s*:\s*\d+\s*\]\s*)?'
            r'(\w+)'
        )

        for pm in port_pattern.finditer(port_text):
            direction = pm.group(1)
            width_str = pm.group(4) or ''
            port_name = pm.group(5)
            width, msb, lsb = _parse_width(width_str)
            is_active_low = _detect_active_low(port_name)
            port = VerilogPort(port_name, direction, width, msb, lsb, is_active_low)
            module.ports.append(port)

        # Also parse port declarations in the body (non-ANSI style)
        body_port_pattern = re.compile(
            r'^\s*(input|output|inout)\s+'
            r'(?:(wire|reg)\s+)?'
            r'(?:(signed)\s+)?'
            r'(\[\s*\d+\s*:\s*\d+\s*\]\s*)?'
            r'(\w+)\s*;',
            re.MULTILINE
        )

        existing_port_names = {p.name for p in module.ports}
        for pm in body_port_pattern.finditer(body_text):
            port_name = pm.group(5)
            if port_name not in existing_port_names:
                direction = pm.group(1)
                width_str = pm.group(4) or ''
                width, msb, lsb = _parse_width(width_str)
                is_active_low = _detect_active_low(port_name)
                port = VerilogPort(port_name, direction, width, msb, lsb, is_active_low)
                module.ports.append(port)
                existing_port_names.add(port_name)

        # Parse wire/reg declarations
        wire_pattern = re.compile(
            r'^\s*(?:wire|reg)\s+'
            r'(?:signed\s+)?'
            r'(\[\s*\d+\s*:\s*\d+\s*\]\s*)?'
            r'(\w+)\s*(?:;|=)',
            re.MULTILINE
        )
        for wm in wire_pattern.finditer(body_text):
            width_str = wm.group(1) or ''
            wire_name = wm.group(2)
            if wire_name not in existing_port_names:
                width, msb, lsb = _parse_width(width_str)
                module.wires.append(VerilogWire(wire_name, width, msb, lsb))

        # Parse module instantiations
        # Pattern: ModuleName [#(...)] instance_name ( .port(signal), ... );
        inst_pattern = re.compile(
            r'(\w+)\s+'                        # module type
            r'(?:#\s*\(([^)]*)\)\s+)?'         # optional parameters
            r'(\w+)\s*'                        # instance name
            r'\(\s*'                           # opening paren
            r'((?:\s*\.\w+\s*\([^)]*\)\s*,?\s*)*)'  # named port connections
            r'\s*\)\s*;',                      # closing paren
            re.DOTALL
        )

        # Keywords that look like instantiations but aren't
        keywords = {
            'assign', 'always', 'initial', 'wire', 'reg', 'input', 'output',
            'inout', 'parameter', 'localparam', 'integer', 'real', 'genvar',
            'generate', 'endgenerate', 'if', 'else', 'case', 'endcase',
            'for', 'while', 'begin', 'end', 'function', 'endfunction',
            'task', 'endtask', 'import', 'signed', 'unsigned',
        }

        for im in inst_pattern.finditer(body_text):
            mod_type = im.group(1)
            if mod_type in keywords:
                continue

            param_text_inst = im.group(2) or ''
            inst_name = im.group(3)
            conn_text = im.group(4) or ''

            # Parse parameter values
            params = {}
            if param_text_inst:
                pp = re.compile(r'\.(\w+)\s*\(([^)]*)\)')
                for ppm in pp.finditer(param_text_inst):
                    params[ppm.group(1)] = ppm.group(2).strip()
                if not params:
                    # Positional parameters
                    vals = [v.strip() for v in param_text_inst.split(',')]
                    for idx, v in enumerate(vals):
                        params[f'param_{idx}'] = v

            # Parse connections
            connections = {}
            conn_pattern = re.compile(r'\.(\w+)\s*\(([^)]*)\)')
            for cm in conn_pattern.finditer(conn_text):
                port_name = cm.group(1)
                signal = cm.group(2).strip()
                connections[port_name] = signal

            if connections:  # Only add if it has named connections (likely a real instantiation)
                instance = VerilogInstance(mod_type, inst_name, connections, params)
                module.instances.append(instance)

        # Parse assign statements
        # Pattern: assign target = source;
        # Also handle: assign target = expr; (we capture the full RHS)
        assign_pattern = re.compile(
            r'^\s*assign\s+'
            r'(\w+(?:\s*\[\s*[^]]*\])?)'   # target (possibly with bit select)
            r'\s*=\s*'
            r'([^;]+)\s*;',                 # source expression
            re.MULTILINE
        )
        for am in assign_pattern.finditer(body_text):
            target = am.group(1).strip()
            source = am.group(2).strip()
            module.assigns.append({
                'target': target,
                'source': source,
            })

        # Parse wire/reg declarations with initialization (Chisel-generated patterns)
        # Pattern: wire [w:0] name = expr;
        # These act like assigns: name is driven by expr
        wire_init_pattern = re.compile(
            r'^\s*(?:wire|reg)\s+'
            r'(?:signed\s+)?'
            r'(?:\[\s*[^]]*\]\s*)?'
            r'(\w+)\s*=\s*'
            r'([^;]+)\s*;',
            re.MULTILINE
        )
        existing_assign_targets = {a['target'].split('[')[0].strip() for a in module.assigns}
        for wim in wire_init_pattern.finditer(body_text):
            wire_name = wim.group(1).strip()
            expr = wim.group(2).strip()
            # Avoid duplicates with existing assigns
            if wire_name not in existing_assign_targets:
                module.assigns.append({
                    'target': wire_name,
                    'source': expr,
                })

        modules.append(module)

    return modules


def parse_verilog_folder(folder_path: str) -> List[VerilogModule]:
    """Parse all Verilog files in a folder and return modules."""
    all_modules = []
    for root, dirs, files in os.walk(folder_path):
        for fname in files:
            if fname.endswith(('.v', '.sv', '.vh')):
                fpath = os.path.join(root, fname)
                try:
                    modules = parse_verilog_file(fpath)
                    all_modules.extend(modules)
                except Exception as e:
                    print(f"Warning: Failed to parse {fpath}: {e}")
    return all_modules


def find_top_modules(modules: List[VerilogModule]) -> List[str]:
    """
    Identify top-level modules.
    A top-level module is one that is never instantiated by any other module.
    """
    all_names = {m.name for m in modules}
    instantiated = set()
    for m in modules:
        for inst in m.instances:
            instantiated.add(inst.module_type)

    top_modules = [name for name in all_names if name not in instantiated]

    # If no top found (circular or all instantiated), return all
    if not top_modules:
        top_modules = list(all_names)

    return sorted(top_modules)


def build_hierarchy(modules: List[VerilogModule]) -> Dict:
    """
    Build a complete hierarchy dict suitable for JSON serialization.
    Returns: {
        'top_modules': [...],
        'modules': { module_name: { ... module data ... }, ... }
    }
    """
    mod_dict = {}
    for m in modules:
        mod_dict[m.name] = m.to_dict()

    top_names = find_top_modules(modules)

    return {
        'top_modules': top_names,
        'modules': mod_dict,
    }


def analyze_and_save(source_path: str, data_dir: str, save_name_override: str = None) -> Dict:
    """
    Analyze Verilog source(s) and save result to data directory.
    source_path can be a file or a folder.
    If a single file is given and it references module types not defined in
    that file, search sibling .v/.sv files in the same directory for those definitions.
    If save_name_override is provided, that name is used as the output filename
    instead of the name derived from the top module or folder.
    Returns the analysis result dict.
    """
    if os.path.isfile(source_path):
        modules = parse_verilog_file(source_path)

        # Check for undefined module types referenced in instances
        defined_names = {m.name for m in modules}
        undefined_types = set()
        for m in modules:
            for inst in m.instances:
                if inst.module_type not in defined_names:
                    undefined_types.add(inst.module_type)

        # Search sibling files in the same directory for missing module defs
        if undefined_types:
            parent_dir = os.path.dirname(os.path.abspath(source_path))
            base_name = os.path.basename(source_path)
            for fname in os.listdir(parent_dir):
                if fname == base_name:
                    continue
                if fname.endswith(('.v', '.sv', '.vh')):
                    sibling_path = os.path.join(parent_dir, fname)
                    try:
                        sibling_modules = parse_verilog_file(sibling_path)
                        for sm in sibling_modules:
                            if sm.name in undefined_types:
                                modules.append(sm)
                                defined_names.add(sm.name)
                                undefined_types.discard(sm.name)
                    except Exception as e:
                        print(f"Warning: Failed to parse sibling {sibling_path}: {e}")
                if not undefined_types:
                    break

    elif os.path.isdir(source_path):
        modules = parse_verilog_folder(source_path)
    else:
        raise FileNotFoundError(f"Path not found: {source_path}")

    if not modules:
        raise ValueError(f"No Verilog modules found in: {source_path}")

    result = build_hierarchy(modules)
    result['source_path'] = os.path.abspath(source_path)

    # Collect all source files that were parsed
    source_files = []
    for m in modules:
        if m.source_file:
            if os.path.isdir(source_path):
                # Walk directory to find the actual full path
                for root, dirs, files in os.walk(source_path):
                    if m.source_file in files:
                        full_path = os.path.join(root, m.source_file)
                        if full_path not in source_files:
                            source_files.append(full_path)
            else:
                full_path = os.path.abspath(source_path)
                if full_path not in source_files:
                    source_files.append(full_path)
                # Also include sibling files that were parsed
                parent_dir = os.path.dirname(full_path)
                sibling_path = os.path.join(parent_dir, m.source_file)
                if os.path.exists(sibling_path) and sibling_path not in source_files:
                    source_files.append(sibling_path)
    result['source_files'] = sorted(source_files)

    # Determine save name from top module or folder name
    top_modules = result['top_modules']
    if save_name_override:
        save_name = save_name_override
    elif len(top_modules) == 1:
        save_name = top_modules[0]
    else:
        if os.path.isdir(source_path):
            save_name = os.path.basename(os.path.normpath(source_path))
        else:
            save_name = os.path.splitext(os.path.basename(source_path))[0]

    os.makedirs(data_dir, exist_ok=True)

    # If a JSON with the same name already exists but was built from a different
    # source path, avoid clobbering it by appending a numeric suffix.
    candidate = save_name
    counter = 1
    while True:
        candidate_path = os.path.join(data_dir, f"{candidate}.json")
        if not os.path.exists(candidate_path):
            break  # free slot
        try:
            with open(candidate_path, 'r', encoding='utf-8') as _f:
                existing = json.load(_f)
            if existing.get('source_path') == os.path.abspath(source_path):
                break  # same source — overwrite is fine
        except Exception:
            break  # unreadable file, overwrite
        candidate = f"{save_name}_{counter}"
        counter += 1
    save_name = candidate
    save_path = candidate_path

    # Build an ordered dict so metadata appears at the top of the JSON file,
    # making source_path / save_path easy to locate without scrolling past
    # the (potentially huge) modules block.
    ordered_result = {
        'source_path': result['source_path'],
        'save_path':   save_path,
        'source_files': result['source_files'],
        'top_modules':  result['top_modules'],
        'modules':      result['modules'],
    }

    with open(save_path, 'w', encoding='utf-8') as f:
        json.dump(ordered_result, f, indent=2, ensure_ascii=False)

    ordered_result['saved_as'] = save_name
    return ordered_result


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print("Usage: python verilog_parser.py <file_or_folder>")
        sys.exit(1)

    data_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data')
    result = analyze_and_save(sys.argv[1], data_dir)
    tops = result['top_modules']
    total = len(result['modules'])
    print(f"Parsed {total} modules, top-level: {tops}")
    print(f"Saved to: data/{result['saved_as']}.json")
