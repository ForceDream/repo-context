













import { LANG_DECLS as DECLS, isDeclLike } from './repoctx-decls.mjs'


const BRANCH_NODES = {
  rust: ['if_expression', 'match_arm', 'while_expression', 'loop_expression', 'for_expression', 'try_expression'],
  ts: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
    'switch_case', 'catch_clause', 'conditional_expression'],
  js: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
    'switch_case', 'catch_clause', 'conditional_expression'],
  py: ['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause',
    'conditional_expression', 'case_clause'],
}

const BRANCH_OPS = new Set(['&&', '||', 'and', 'or', '??'])


const LOCAL_DECL_NODES = [
  'formal_parameters', 'parameters', 'required_parameter', 'optional_parameter',
  'typed_parameter', 'default_parameter', 'rest_pattern', 'variable_declarator',
  'let_declaration', 'assignment_pattern', 'shorthand_property_identifier_pattern',
]
const IDENT_NODES = ['identifier', 'property_identifier', 'type_identifier', 'field_identifier']

export async function createAstExtractor({ wasmDir }) {
  const fs = await import('node:fs')
  const path = await import('node:path')




  let mod
  let Parser
  try {
    mod = await import('web-tree-sitter')
    Parser = mod.Parser || mod.default
    if (!Parser?.init) throw new Error('exports 中没有 Parser')
  } catch (e) {
    return { available: false, reason: `web-tree-sitter 加载失败：${e.message}` }
  }

  await Parser.init()


  const Language = mod.Language || Parser.Language
  if (!Language?.load) {
    return { available: false, reason: 'web-tree-sitter 未暴露 Language.load（runtime 与语法 ABI 版本可能不匹配）' }
  }
  const parser = new Parser()

  const FILE = {
    rust: 'tree-sitter-rust.wasm', ts: 'tree-sitter-typescript.wasm', tsx: 'tree-sitter-tsx.wasm',
    js: 'tree-sitter-javascript.wasm', jsx: 'tree-sitter-javascript.wasm', py: 'tree-sitter-python.wasm',
  }
  const langs = {}
  const missing = []
  for (const [key, file] of Object.entries(FILE)) {
    const p = path.join(wasmDir, file)
    if (!fs.existsSync(p)) { missing.push(`${file}(缺文件)`); continue }
    try { langs[key] = await Language.load(p) } catch (e) {
      missing.push(`${file}(ABI/版本不匹配：${e.message || '空消息——语法 ABI 与 runtime 不符'})`)
    }
  }
  if (!Object.keys(langs).length) return { available: false, reason: `语法文件不可用：${missing.join(', ')}` }

  const MAX_PARSE_BYTES = 1024 * 1024

  

  const SIMPLE_NAME = /^[A-Za-z_$][\w$]*$/
  




  const LOCAL_DECL_TYPES = new Set(['type_parameter', 'constrained_type_parameter', 'type_binding'])

  function nameOf(node, kind) {
    const direct = node.childForFieldName?.('name')
    if (direct && SIMPLE_NAME.test(direct.text)) return direct.text
    if (kind === 'impl') {
      const t = node.childForFieldName?.('type')
      if (t) {
        const n = t.text.replace(/<.*$/, '')
        if (SIMPLE_NAME.test(n)) return n
      }
    }
    if (kind === 'var' || kind === 'const') {
      const d = (node.descendantsOfType?.('variable_declarator') || [])[0]
      const n = d?.childForFieldName?.('name')
      if (n && SIMPLE_NAME.test(n.text)) return n.text
    }
    if (LOCAL_DECL_TYPES.has(node.type)) {


      for (const f of ['name', 'left']) {
        const x = node.childForFieldName?.(f)
        if (x && SIMPLE_NAME.test(x.text)) return x.text
      }
      const id = (node.descendantsOfType?.(['type_identifier', 'identifier']) || [])[0]
      if (id && SIMPLE_NAME.test(id.text)) return id.text
    }
    return null
  }

  function cyclomatic(symNode, lang) {
    let decisions = 0
    for (const t of (BRANCH_NODES[lang] || [])) decisions += (symNode.descendantsOfType?.(t) || []).length
    for (const b of (symNode.descendantsOfType?.('binary_expression') || [])) {
      const op = b.childForFieldName?.('operator')?.text
      if (op && BRANCH_OPS.has(op)) decisions++
    }
    return decisions + 1
  }

  










  
  function extract(relPath, lang, text) {
    const language = langs[lang]
    if (!language) return null
    if (text.length > MAX_PARSE_BYTES) return null
    parser.setLanguage(language)
    let tree
    try { tree = parser.parse(text) } catch { return null }
    if (!tree) return null

    const out = []
    const root = tree.rootNode
    
    const CONTAINERS = {
      rust: { impl_item: 'impl', trait_item: 'trait', struct_item: 'struct', enum_item: 'enum', mod_item: 'mod', function_item: 'fn' },
      ts: {
        class_declaration: 'class', abstract_class_declaration: 'class', interface_declaration: 'iface',
        namespace_declaration: 'mod', module: 'mod', function_declaration: 'fn',
        method_definition: 'method', lexical_declaration: 'var',
      },
      js: { class_declaration: 'class', function_declaration: 'fn', method_definition: 'method', lexical_declaration: 'var' },
      py: { class_definition: 'class', function_definition: 'fn' },
    }
    






    function qualifiedName(node, name) {
      const cmap = CONTAINERS[lang === 'tsx' ? 'ts' : lang] || {}
      const chain = []
      let p = node.parent

      for (let guard = 0; p && guard < 40; guard++, p = p.parent) {
        const k = cmap[p.type]
        if (!k) continue
        const n = nameOf(p, k)
        if (n && n !== name) chain.unshift(n)
      }
      return chain.length ? `${chain.join('::')}::${name}` : name
    }







    
    const FIELD_DECL_NODES = ['variable_declarator', 'let_declaration', 'required_parameter',
      'optional_parameter', 'typed_parameter', 'default_parameter', 'assignment_pattern']
    const PARAM_LIST_NODES = ['formal_parameters', 'parameters']




    const WANTED_TYPES = [...new Set([
      ...IDENT_NODES, ...(BRANCH_NODES[lang] || []), 'binary_expression',
      ...FIELD_DECL_NODES, ...PARAM_LIST_NODES,

      'import_statement', 'use_declaration',
    ])]
    const identSet = new Set(IDENT_NODES)
    const branchSet = new Set(BRANCH_NODES[lang] || [])
    const fieldSet = new Set(FIELD_DECL_NODES)
    const paramSet = new Set(PARAM_LIST_NODES)

    const identNodes = []
    const cxMarks = []
    const fieldDecls = []
    const paramLists = []
    const importNodes = []
    for (const n of (root.descendantsOfType?.(WANTED_TYPES) || [])) {
      const t = n.type


      if (identSet.has(t)) identNodes.push({ s: n.startIndex, t: n.text, ty: t })

      if (branchSet.has(t)) cxMarks.push({ s: n.startIndex })
      if (t === 'binary_expression' && BRANCH_OPS.has(n.childForFieldName?.('operator')?.text)) cxMarks.push({ s: n.startIndex })
      if (fieldSet.has(t)) fieldDecls.push({ s: n.startIndex, n })
      if (paramSet.has(t)) paramLists.push({ s: n.startIndex, n })
      if (t === 'import_statement' || t === 'use_declaration') importNodes.push(n)
    }
    for (const arr of [identNodes, cxMarks, fieldDecls, paramLists]) arr.sort((a, b) => a.s - b.s)






    const scopedCalls = []
    if (lang === 'rust') {
      for (const c of (root.descendantsOfType?.('call_expression') || [])) {
        const fn = c.childForFieldName?.('function')
        if (!fn || fn.type !== 'scoped_identifier') continue
        const segs = fn.text.split('::')
        if (segs.length < 2) continue
        const nm = segs[segs.length - 1]
        if (!SIMPLE_NAME.test(nm)) continue

        scopedCalls.push({ s: fn.startIndex, path: segs.slice(0, -1).join('::'), name: nm })
      }
      scopedCalls.sort((a, b) => a.s - b.s)
    }

    








    const importAliases = new Map()
    const importNames = new Set()
    const SKIP_PATH_SEG = new Set(['self', 'crate', 'super', 'std', 'core', 'alloc'])
    const addBinding = (orig, local) => {
      const o = orig && SIMPLE_NAME.test(orig) ? orig : null
      const l = local && SIMPLE_NAME.test(local) ? local : null
      if (o && !SKIP_PATH_SEG.has(o)) importNames.add(o)
      if (o && l && l !== o) importAliases.set(l, o)
    }
    const lastSeg = (p) => p.text.split('::').pop()
    
    const rustUseArg = (arg) => {
      if (!arg) return
      switch (arg.type) {
        case 'identifier': case 'type_identifier': addBinding(arg.text, arg.text); break
        case 'use_as_clause': {
          const p = arg.childForFieldName?.('path'); const al = arg.childForFieldName?.('alias')
          if (p && al) addBinding(lastSeg(p), al.text)
          break
        }
        case 'scoped_identifier': addBinding(lastSeg(arg), lastSeg(arg)); break
        case 'scoped_use_list': {
          const list = arg.childForFieldName?.('list')
          for (const c of (list?.namedChildren || [])) rustUseArg(c)
          break
        }
        case 'use_list': for (const c of arg.namedChildren || []) rustUseArg(c); break
        default: break
      }
    }
    for (const st of importNodes) {
      if (st.type === 'use_declaration') {
        rustUseArg(st.childForFieldName?.('argument'))
        continue
      }
      const clause = (st.namedChildren || []).find((c) => c.type === 'import_clause')
      if (!clause) continue
      for (const c of clause.namedChildren || []) {
        if (c.type === 'identifier') addBinding(c.text, c.text)
        else if (c.type === 'named_imports') {
          for (const sp of c.namedChildren || []) {
            if (sp.type !== 'import_specifier') continue
            const nm = sp.childForFieldName?.('name')?.text
            const al = sp.childForFieldName?.('alias')?.text
            addBinding(nm, al || nm)
          }
        }

      }
    }

    const lowerBound = (arr, x) => { let l = 0, r = arr.length; while (l < r) { const m = (l + r) >> 1; if (arr[m].s < x) l = m + 1; else r = m } return l }
    const upperBound = (arr, x) => { let l = 0, r = arr.length; while (l < r) { const m = (l + r) >> 1; if (arr[m].s <= x) l = m + 1; else r = m } return l }


    for (const [type, kind] of DECLS[lang === 'tsx' ? 'ts' : lang] || DECLS[lang] || []) {
      for (const node of (root.descendantsOfType?.(type) || [])) {
        const name = nameOf(node, kind)


        const isLocalDecl = LOCAL_DECL_TYPES.has(node.type)
        if (!name || (name.length < 2 && !isLocalDecl)) continue
        const a = node.startIndex
        const b = node.endIndex


        const locals = new Set()
        for (let k = lowerBound(fieldDecls, a), e = upperBound(fieldDecls, b); k < e; k++) {
          for (const f of ['name', 'pattern']) {
            const fld = fieldDecls[k].n.childForFieldName?.(f)
            if (!fld) continue
            if (fld.type === 'identifier' || fld.type === 'shorthand_property_identifier_pattern') { locals.add(fld.text); continue }
            for (const id of (fld.descendantsOfType?.(IDENT_NODES) || [])) locals.add(id.text)
          }
        }




        const BINDING_NODES = ['identifier', 'shorthand_property_identifier_pattern']
        for (let k = lowerBound(paramLists, a), e = upperBound(paramLists, b); k < e; k++) {
          for (const id of (paramLists[k].n.descendantsOfType?.(BINDING_NODES) || [])) locals.add(id.text)
        }






        const refs = new Set()
        const trefs = new Set()
        for (let k = lowerBound(identNodes, a), e = upperBound(identNodes, b); k < e; k++) {
          const x = identNodes[k]
          const t = x.t
          if (t === name || locals.has(t)) continue
          if (x.ty === 'type_identifier') { if (t.length >= 2) trefs.add(t); continue }
          if (t.length < 3) continue

          refs.add(t)
        }



        const qrefs = []
        const qseen = new Set()
        for (let k = lowerBound(scopedCalls, a), e = upperBound(scopedCalls, b); k < e; k++) {
          const sc = scopedCalls[k]
          if (sc.name === name || sc.name.length < 3) continue
          const key = `${sc.path}::${sc.name}`
          if (qseen.has(key)) continue
          qseen.add(key)
          qrefs.push({ path: sc.path, name: sc.name })
        }

        const q = qualifiedName(node, name)





        let exp
        if (lang === 'rust') exp = node.children.some((c) => c.type === 'visibility_modifier')
        else if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx') exp = /(^|\s)export\s*$/.test(text.slice(Math.max(0, a - 24), a))



        let tr
        if (kind === 'impl') {
          const tn = node.childForFieldName?.('trait')
          if (tn) {
            const n = tn.text.replace(/<.*$/, '').split('::').pop()
            if (SIMPLE_NAME.test(n)) tr = n
          }
        }
        out.push({
          name,
          kind,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          ind: node.startPosition.column,
          cx: upperBound(cxMarks, b) - lowerBound(cxMarks, a) + 1,
          sig: text.slice(a, a + 200).split('\n')[0].trim(),
          q: q === name ? undefined : q,
          tr,
          qrefs: qrefs.length ? qrefs : undefined,
          exp,
          local: LOCAL_DECL_TYPES.has(node.type) ? true : undefined,
          refs: [...refs],
          trefs: trefs.size ? [...trefs].sort() : undefined,
        })
      }
    }

    const seen = new Set()
    const dedup = out.filter((s) => {
      const key = `${s.line}|${s.name}|${s.kind}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    dedup.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))


    dedup.imports = { aliases: importAliases, names: [...importNames].sort() }
    tree.delete?.()
    return dedup
  }

  










  function nodeTypeCensus(relPath, lang, text) {
    const language = langs[lang]
    if (!language) return null
    if (text.length > MAX_PARSE_BYTES) return null
    parser.setLanguage(language)
    let tree
    try { tree = parser.parse(text) } catch { return null }
    if (!tree) return null
    const counts = new Map()
    const samples = new Map()
    const stack = [tree.rootNode]
    while (stack.length) {
      const n = stack.pop()

      const named = typeof n.isNamed === 'function' ? n.isNamed() : n.isNamed !== false
      if (named) {
        counts.set(n.type, (counts.get(n.type) || 0) + 1)
        if (!samples.has(n.type) && isDeclLike(n.type)) {
          samples.set(n.type, `${relPath}:${n.startPosition.row + 1}: ${n.text.slice(0, 72).replace(/\s+/g, ' ')}`)
        }
      }
      const ch = typeof n.children === 'function' ? n.children() : n.children
      if (ch) for (let i = 0; i < ch.length; i++) stack.push(ch[i])
    }
    tree.delete?.()
    return { counts, samples }
  }

  return { available: true, extract, nodeTypeCensus, langs: Object.keys(langs), missing }
}
