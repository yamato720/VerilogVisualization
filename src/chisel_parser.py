"""
Chisel source code parser.
Extracts module definitions, IO ports, and module instantiations from Scala/Chisel files.
"""

import os
import re
import json

EDITABLE_MARKER = '// editable'


class ChiselPort:
    """Represents a Chisel IO port."""
    def __init__(self, name, direction, width=1):
        self.name = name
        self.direction = direction  # 'input' or 'output'
        self.width = width
        self.condition = None  # parameter name for conditional ports

    def to_dict(self):
        d = {
            'name': self.name,
            'direction': self.direction,
            'width': self.width,
        }
        if self.condition:
            d['condition'] = self.condition
        return d


class ChiselModule:
    """Represents a Chisel module definition."""
    def __init__(self, name, file_path=''):
        self.name = name
        self.file_path = file_path
        self.ports = []        # List[ChiselPort]
        self.instances = []    # List[dict] with module_type, instance_name
        self.connections = []  # List[dict] {lhs, rhs} from := assignments
        self.params = []       # List[dict] {name, type, default}
        self.internal_vals = [] # List[dict] {name, expr, condition?}
        self.raw_io = ''       # Raw IO bundle text
        self.editable = False  # Whether the file has '// editable' marker

    def to_dict(self):
        return {
            'name': self.name,
            'file_path': self.file_path,
            'ports': [p.to_dict() for p in self.ports],
            'instances': self.instances,
            'connections': self.connections,
            'params': self.params,
            'internal_vals': self.internal_vals,
            'raw_io': self.raw_io,
            'editable': self.editable,
        }


def parse_chisel_width(width_str):
    """Parse a Chisel width expression like '8.W', '32.W', 'params.width' into integer."""
    width_str = width_str.strip()
    # Match "N.W" pattern
    m = re.match(r'^(\d+)\.W$', width_str)
    if m:
        return int(m.group(1))
    # Match plain number
    m = re.match(r'^(\d+)$', width_str)
    if m:
        return int(m.group(1))
    # Can't determine — default to 1
    return 1


def find_matching_paren(text, open_pos):
    """Find the matching closing parenthesis accounting for nesting."""
    depth = 1
    i = open_pos + 1
    in_str = False
    str_char = None
    while i < len(text) and depth > 0:
        c = text[i]
        if in_str:
            if c == str_char and text[i - 1] != '\\':
                in_str = False
        else:
            if c in ('"', "'"):
                in_str = True
                str_char = c
            elif c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
        i += 1
    return i - 1 if depth == 0 else -1


def parse_constructor_params(param_text):
    """Parse Chisel class constructor parameters.
    e.g. 'Width:Int = 64, Debug:Boolean = false' -> [{name, type, default}]
    """
    params = []
    # Split by commas, but respect nested parens/strings
    parts = []
    depth = 0
    current = ''
    in_str = False
    str_char = None
    for c in param_text:
        if in_str:
            current += c
            if c == str_char:
                in_str = False
        elif c in ('"', "'"):
            in_str = True
            str_char = c
            current += c
        elif c == '(':
            depth += 1
            current += c
        elif c == ')':
            depth -= 1
            current += c
        elif c == ',' and depth == 0:
            parts.append(current.strip())
            current = ''
        else:
            current += c
    if current.strip():
        parts.append(current.strip())

    for part in parts:
        # Match: name: Type = default  or  name: Type
        m = re.match(r'(\w+)\s*:\s*(\w[\w\[\]\.]*)\s*(?:=\s*(.+))?$', part.strip())
        if m:
            params.append({
                'name': m.group(1),
                'type': m.group(2),
                'default': m.group(3).strip() if m.group(3) else None,
            })
    return params


def parse_chisel_io_ports(io_block):
    """
    Parse IO ports from a Chisel IO bundle block.
    Handles common patterns:
      val x = Input(UInt(8.W))
      val y = Output(Bool())
      val z = Input(Vec(4, UInt(8.W)))
      val a = Flipped(Decoupled(UInt(8.W)))
    """
    ports = []
    # Match val/var name = Input/Output/Flipped(...) patterns
    port_pattern = re.compile(
        r'(?:val|var)\s+(\w+)\s*=\s*(Input|Output|Flipped)\s*\((.+?)\)\s*$',
        re.MULTILINE
    )

    for m in port_pattern.finditer(io_block):
        name = m.group(1)
        dir_keyword = m.group(2)
        type_str = m.group(3).strip()

        if dir_keyword == 'Input':
            direction = 'input'
        elif dir_keyword == 'Output':
            direction = 'output'
        elif dir_keyword == 'Flipped':
            # Flipped reverses direction — treat as input for Decoupled (simplified)
            direction = 'input'
        else:
            direction = 'input'

        width = extract_width_from_type(type_str)
        ports.append(ChiselPort(name, direction, width))

    return ports


def extract_width_from_type(type_str):
    """Extract bit width from a Chisel type string."""
    type_str = type_str.strip()

    # Bool() -> 1
    if re.match(r'^Bool\(\)', type_str):
        return 1

    # UInt(N.W) or SInt(N.W)
    m = re.match(r'^[US]Int\((\d+)\.W\)', type_str)
    if m:
        return int(m.group(1))

    # UInt(N) (shorthand)
    m = re.match(r'^[US]Int\((\d+)\)', type_str)
    if m:
        return int(m.group(1))

    # Vec(n, Type)
    m = re.match(r'^Vec\(\s*(\d+)\s*,\s*(.+)\)', type_str)
    if m:
        count = int(m.group(1))
        inner_width = extract_width_from_type(m.group(2))
        return count * inner_width

    # Decoupled(Type) or other bundle wrappers
    m = re.match(r'^Decoupled\((.+)\)', type_str)
    if m:
        return extract_width_from_type(m.group(1))

    # Default
    return 1


def parse_chisel_file(file_path):
    """
    Parse a single Chisel (.scala) file.
    Returns a list of ChiselModule objects found in the file.
    """
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    modules = []
    is_editable = EDITABLE_MARKER in content

    # Find class definitions that extend Module or other Chisel base classes
    # Use simpler regex to find 'class Name' then manually handle constructor parens
    class_pattern = re.compile(r'class\s+(\w+)\s*(\()?')

    for m in class_pattern.finditer(content):
        # Skip commented-out class definitions
        line_start = content.rfind('\n', 0, m.start()) + 1
        if '//' in content[line_start:m.start()]:
            continue

        mod_name = m.group(1)
        has_paren = m.group(2) == '('
        param_text = ''

        # Determine where the constructor ends and check for 'extends Module'
        if has_paren:
            close_pos = find_matching_paren(content, m.start(2))
            if close_pos < 0:
                continue
            after_paren = content[close_pos + 1:]
            param_text = content[m.start(2) + 1:close_pos]
        else:
            after_paren = content[m.end():]

        # Check that this class extends a Chisel base class
        extends_match = re.match(r'\s*extends\s+(?:Module|MultiIOModule|RawModule|BlackBox|ExtModule)', after_paren)
        if not extends_match:
            continue

        mod = ChiselModule(mod_name, file_path)
        mod.editable = is_editable

        # Parse constructor parameters
        if param_text.strip():
            mod.params = parse_constructor_params(param_text)

        # Find the module body by tracking braces
        if has_paren:
            # body starts after the extends match
            body_start_offset = close_pos + 1 + extends_match.end()
        else:
            body_start_offset = m.end() + extends_match.end()
        body = extract_brace_block(content, body_start_offset)
        if body is None:
            modules.append(mod)
            continue

        # Extract IO bundle — try balanced brace matching for reliability
        io_start = re.search(r'(?:val|var)\s+io\s*=\s*IO\s*\(\s*new\s+Bundle\s*(?:\(\))?\s*\{', body)
        if io_start:
            # Use extract_brace_block within body string
            io_block_text = extract_brace_block(body, io_start.end() - 1)
            if io_block_text:
                mod.raw_io = io_block_text.strip()
                mod.ports = parse_chisel_io_ports(io_block_text)
                # Also parse conditional ports: if (cond) Some(Dir(Type)) else None
                cond_port_pattern = re.compile(
                    r'(?:val|var)\s+(\w+)\s*=\s*if\s*\(.+?\)\s*Some\s*\(\s*(Input|Output)\s*\((.+?)\)\s*\)',
                    re.DOTALL
                )
                for cp in cond_port_pattern.finditer(io_block_text):
                    pname = cp.group(1)
                    pdir = 'input' if cp.group(2) == 'Input' else 'output'
                    ptype = cp.group(3).strip()
                    # Extract condition variable from 'if (Cond)'
                    cond_match = re.search(r'if\s*\((\w+)\)', io_block_text[cp.start():cp.end()])
                    condition = cond_match.group(1) if cond_match else None
                    # Check if port already parsed by standard parser
                    if not any(p.name == pname for p in mod.ports):
                        width = extract_width_from_type(ptype)
                        port = ChiselPort(pname, pdir, width)
                        port.condition = condition
                        mod.ports.append(port)
        else:
            # Try simpler IO pattern: val/var io = IO(SomeBundle())
            io_simple = re.search(r'(?:val|var)\s+io\s*=\s*IO\s*\((.+?)\)', body)
            if io_simple:
                mod.raw_io = io_simple.group(1).strip()

        # Find module instantiations: Module(new SomeModule(...))
        # Also capture constructor arguments for paramValues
        inst_pattern = re.compile(r'val\s+(\w+)\s*=\s*Module\s*\(\s*new\s+(\w+)\s*(\()?', re.MULTILINE)
        for inst_m in inst_pattern.finditer(body):
            inst_name = inst_m.group(1)
            inst_type = inst_m.group(2)
            inst_info = {
                'instance_name': inst_name,
                'module_type': inst_type,
            }
            # Parse constructor arguments if present
            if inst_m.group(3) == '(':
                paren_start = inst_m.start(3)
                # find_matching_paren works on content; need body-relative offset
                close_pos = find_matching_paren(body, paren_start)
                if close_pos > 0:
                    args_text = body[paren_start + 1:close_pos].strip()
                    if args_text:
                        inst_info['args_text'] = args_text
            mod.instances.append(inst_info)

        # Parse internal val assignments (non-io, non-Module)
        # e.g. val Sel_num = if (M_Extension) 2 else 1
        val_pattern = re.compile(
            r'val\s+(\w+)\s*=\s*(?!Module|IO|Wire|Reg|Mem)(.+)',
            re.MULTILINE,
        )
        for vm in val_pattern.finditer(body):
            vname = vm.group(1)
            vexpr = vm.group(2).strip()
            # Skip if it's already captured as an instance
            if any(i['instance_name'] == vname for i in mod.instances):
                continue
            # Skip io declaration
            if vname == 'io':
                continue
            val_entry = {'name': vname, 'expr': vexpr}
            # Check if it's a conditional expression
            if_match = re.match(r'if\s*\((.+?)\)\s*(.+?)\s+else\s+(.+)', vexpr)
            if if_match:
                val_entry['condition'] = if_match.group(1).strip()
                val_entry['then_val'] = if_match.group(2).strip()
                val_entry['else_val'] = if_match.group(3).strip()
            mod.internal_vals.append(val_entry)

        # Parse wire connections: find := assignments and extract endpoints
        # Strip line comments for clean parsing
        clean_lines = []
        for line in body.split('\n'):
            code_part = line.split('//')[0]
            clean_lines.append(code_part)
        clean_body = '\n'.join(clean_lines)

        # Endpoint pattern: inst.io.pin[.get] or io.pin[.get]
        ep_re = re.compile(r'(?:(\w+)\.io\.(\w+)|io\.(\w+))(?:\.get)?')

        # Find all := assignment lines where LHS is an io endpoint
        assign_re = re.compile(
            r'((?:\w+\.)?io\.\w+(?:\.get)?)\s*:=\s*(.+)',
            re.MULTILINE,
        )
        for am in assign_re.finditer(clean_body):
            lhs_raw = am.group(1).strip()
            rhs_raw = am.group(2).strip()

            # Parse LHS
            lhs_m = ep_re.match(lhs_raw)
            if not lhs_m:
                continue
            if lhs_m.group(1) is not None:
                lhs = {'type': 'instance', 'instanceId': lhs_m.group(1), 'pinName': lhs_m.group(2)}
            else:
                lhs = {'type': 'module-pin', 'instanceId': None, 'pinName': lhs_m.group(3)}

            # Find all inst.io.pin / io.pin references in RHS
            rhs_endpoints = list(ep_re.finditer(rhs_raw))
            if not rhs_endpoints:
                continue  # RHS is a constant/expression with no pin refs

            for rhs_m in rhs_endpoints:
                if rhs_m.group(1) is not None:
                    rhs = {'type': 'instance', 'instanceId': rhs_m.group(1), 'pinName': rhs_m.group(2)}
                else:
                    rhs = {'type': 'module-pin', 'instanceId': None, 'pinName': rhs_m.group(3)}
                mod.connections.append({'lhs': lhs, 'rhs': rhs})

        modules.append(mod)

    return modules


def extract_brace_block(content, start_pos):
    """
    Extract the content within curly braces starting from start_pos.
    Handles nested braces. Returns the content between { and }.
    """
    # Find the opening brace
    idx = content.find('{', start_pos)
    if idx == -1:
        return None

    depth = 1
    i = idx + 1
    while i < len(content) and depth > 0:
        if content[i] == '{':
            depth += 1
        elif content[i] == '}':
            depth -= 1
        i += 1

    if depth != 0:
        return None

    return content[idx + 1:i - 1]


def parse_chisel_folder(folder_path):
    """
    Parse all .scala files in a folder.
    Returns a dict of module_name -> ChiselModule.to_dict().
    """
    all_modules = {}

    for root, dirs, files in os.walk(folder_path):
        for fname in sorted(files):
            if fname.endswith('.scala'):
                fpath = os.path.join(root, fname)
                try:
                    modules = parse_chisel_file(fpath)
                    for mod in modules:
                        all_modules[mod.name] = mod.to_dict()
                except Exception as e:
                    print(f"Warning: Failed to parse {fpath}: {e}")

    return all_modules


def list_scala_files(folder_path):
    """List all .scala files in the given folder (non-recursive, just top level)."""
    files = []
    if not os.path.isdir(folder_path):
        return files
    for fname in sorted(os.listdir(folder_path)):
        if fname.endswith('.scala'):
            fpath = os.path.join(folder_path, fname)
            if os.path.isfile(fpath):
                files.append({
                    'name': fname,
                    'path': fpath,
                })
    return files


def get_modules_in_file(file_path):
    """Parse a single file and return list of module names."""
    modules = parse_chisel_file(file_path)
    return [m.to_dict() for m in modules]


def is_file_editable(file_path):
    """Return True if the .scala file contains the '// editable' marker line."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        return EDITABLE_MARKER in content
    except Exception:
        return False


def detect_package(folder_path):
    """Detect the package declaration from existing .scala files in the folder."""
    for fname in os.listdir(folder_path):
        if fname.endswith('.scala'):
            fpath = os.path.join(folder_path, fname)
            try:
                with open(fpath, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith('package '):
                            return line
            except Exception:
                pass
    return None


def create_chisel_file(folder_path, file_name, import_scala_path=None):
    """
    Create a new .scala file in the folder with package and imports.
    Returns the created file path.
    """
    if not file_name.endswith('.scala'):
        file_name += '.scala'

    file_path = os.path.join(folder_path, file_name)
    if os.path.exists(file_path):
        raise FileExistsError(f"File already exists: {file_path}")

    # Detect package from sibling files
    package_line = detect_package(folder_path)

    # Read import.scala content
    imports = ''
    if import_scala_path and os.path.isfile(import_scala_path):
        with open(import_scala_path, 'r', encoding='utf-8') as f:
            imports = f.read().strip()

    # Build file content
    lines = []
    if package_line:
        lines.append(package_line)
        lines.append('')
    if imports:
        lines.append(imports)
        lines.append('')
    lines.append(EDITABLE_MARKER)
    lines.append('')

    content = '\n'.join(lines) + '\n'

    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)

    return file_path


def save_module_to_file(file_path, module_name, ports):
    """
    Append or update a module definition in a Chisel file.
    ports: list of { name, direction, width }
    """
    # Build IO bundle
    io_lines = []
    for p in ports:
        dir_kw = 'Input' if p['direction'] == 'input' else 'Output'
        width = p.get('width', 1)
        if width == 1:
            type_str = 'Bool()'
        else:
            type_str = f'UInt({width}.W)'
        io_lines.append(f'    val {p["name"]} = {dir_kw}({type_str})')

    io_block = '\n'.join(io_lines)

    module_code = f"""
class {module_name} extends Module {{
  val io = IO(new Bundle {{
{io_block}
  }})

  // TODO: Implement module logic
}}
"""

    # Check if module already exists in file
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # If module already exists, replace it
    span = find_class_span(content, module_name)
    if span:
        start, end = span
        new_content = content[:start] + module_code.strip() + '\n' + content[end:]
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
    else:
        # Append the module
        with open(file_path, 'a', encoding='utf-8') as f:
            f.write(module_code)

    return True


def find_class_span(content, module_name):
    """Find the start and end positions of a Chisel class definition in content.
    Handles constructors with nested parentheses.
    Returns (start, end) or None if not found.
    """
    pattern = re.compile(r'class\s+' + re.escape(module_name) + r'\s*(\()?')
    for m in pattern.finditer(content):
        line_start = content.rfind('\n', 0, m.start()) + 1
        if '//' in content[line_start:m.start()]:
            continue
        has_paren = m.group(1) == '('
        if has_paren:
            close_pos = find_matching_paren(content, m.start(1))
            if close_pos < 0:
                continue
            after = content[close_pos + 1:]
        else:
            after = content[m.end():]
        ext = re.match(r'\s*extends\s+(?:Module|MultiIOModule|RawModule|BlackBox|ExtModule)', after)
        if not ext:
            continue
        # Find the opening { of the class body
        if has_paren:
            search_from = close_pos + 1 + ext.end()
        else:
            search_from = m.end() + ext.end()
        brace_start = content.find('{', search_from)
        if brace_start < 0:
            continue
        depth = 1
        i = brace_start + 1
        while i < len(content) and depth > 0:
            if content[i] == '{':
                depth += 1
            elif content[i] == '}':
                depth -= 1
            i += 1
        if depth == 0:
            return (m.start(), i)
    return None


def save_canvas_to_file(file_path, module_name, ports, instances, wires, all_modules_ports, params=None):
    """
    Write back the visual canvas state to a Chisel module class in file_path.
    - ports: [{name, direction, width}]      — the module's IO bundle
    - instances: [{id, moduleType, paramValues?}] — sub-module instantiations
    - wires: [{from:{type,instanceId,pinName}, to:{type,instanceId,pinName}}]
    - all_modules_ports: {moduleName: [{name, direction, width}]}  — for wire direction resolution
    - params: [{name, type, default}]         — constructor parameters
    """
    # ── Constructor parameters ──────────────────────────────────────────────
    params = params or []
    if params:
        param_parts = []
        for p in params:
            s = f'{p["name"]}: {p.get("type", "Int")}'
            if p.get('default') is not None and p['default'] != '':
                s += f' = {p["default"]}'
            param_parts.append(s)
        param_str = '(' + ', '.join(param_parts) + ')'
    else:
        param_str = ''
    # ── IO bundle ──────────────────────────────────────────────────────────
    io_lines = []
    for p in ports:
        dir_kw = 'Input' if p['direction'] == 'input' else 'Output'
        width = p.get('width', 1)
        type_str = 'Bool()' if width == 1 else f'UInt({width}.W)'
        io_lines.append(f'    val {p["name"]} = {dir_kw}({type_str})')

    # ── Instance declarations ───────────────────────────────────────────────
    inst_lines = []
    for inst in instances:
        pv = inst.get('paramValues') or {}
        if pv:
            args = ', '.join(f'{k} = {v}' for k, v in pv.items())
            inst_lines.append(f'  val {inst["id"]} = Module(new {inst["moduleType"]}({args}))')
        else:
            inst_lines.append(f'  val {inst["id"]} = Module(new {inst["moduleType"]}())')

    # ── Wire connections (:=) ───────────────────────────────────────────────
    def port_ref(info):
        if info.get('type') == 'module-pin':
            return f'io.{info["pinName"]}'
        return f'{info["instanceId"]}.io.{info["pinName"]}'

    def port_role(info):
        """Returns 'source' (drives things) or 'dest' (is driven)."""
        if info.get('type') == 'module-pin':
            # Module input = comes from outside = source for internal logic
            for p in ports:
                if p['name'] == info['pinName']:
                    return 'source' if p['direction'] == 'input' else 'dest'
            return 'unknown'
        else:
            inst = next((i for i in instances if i.get('id') == info.get('instanceId')), None)
            if inst:
                for p in all_modules_ports.get(inst['moduleType'], []):
                    if p['name'] == info['pinName']:
                        return 'source' if p['direction'] == 'output' else 'dest'
            return 'unknown'

    wire_lines = []
    for wire in wires:
        fi = wire.get('from', {})
        ti = wire.get('to', {})
        fr = port_ref(fi)
        tr = port_ref(ti)
        fr_role = port_role(fi)
        tr_role = port_role(ti)
        # LHS := RHS  means  dest := source
        if fr_role == 'source':
            wire_lines.append(f'  {tr} := {fr}')
        elif tr_role == 'source':
            wire_lines.append(f'  {fr} := {tr}')
        else:
            wire_lines.append(f'  {tr} := {fr}')  # fallback: keep draw direction

    # ── Assemble module code ────────────────────────────────────────────────
    module_lines = [f'class {module_name}{param_str} extends Module {{']
    module_lines.append('  val io = IO(new Bundle {')
    module_lines.extend(io_lines)
    module_lines.append('  })')
    if inst_lines:
        module_lines.append('')
        module_lines.extend(inst_lines)
    if wire_lines:
        module_lines.append('')
        module_lines.extend(wire_lines)
    module_lines.append('}')
    module_code = '\n'.join(module_lines)

    # ── Write back to file ──────────────────────────────────────────────────
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    span = find_class_span(content, module_name)
    if span:
        start, end = span
        new_content = content[:start] + module_code + '\n' + content[end:].lstrip('\n')
    else:
        new_content = content.rstrip('\n') + '\n\n' + module_code + '\n'

    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(new_content)

    return True
