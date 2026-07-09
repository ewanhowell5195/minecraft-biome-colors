const TAG = {
  UTF8: 1, INTEGER: 3, FLOAT: 4, LONG: 5, DOUBLE: 6, CLASS: 7, STRING: 8,
  FIELDREF: 9, METHODREF: 10, IFACE_METHODREF: 11, NAMEANDTYPE: 12,
  METHODHANDLE: 15, METHODTYPE: 16, DYNAMIC: 17, INVOKEDYNAMIC: 18,
  MODULE: 19, PACKAGE: 20,
}

export function parseClass(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let p = 0
  const u1 = () => dv.getUint8(p++)
  const u2 = () => { const v = dv.getUint16(p); p += 2; return v }
  const u4 = () => { const v = dv.getUint32(p); p += 4; return v }

  if (u4() !== 0xcafebabe) throw new Error("not a class file")
  u2(); u2() // minor, major

  const cpCount = u2()
  const cp = new Array(cpCount) // 1-indexed
  for (let i = 1; i < cpCount; i++) {
    const tag = u1()
    switch (tag) {
      case TAG.UTF8: {
        const len = u2()
        const bytes = new Uint8Array(buf.buffer, buf.byteOffset + p, len)
        cp[i] = { tag, value: utf8(bytes) }
        p += len
        break
      }
      case TAG.INTEGER: cp[i] = { tag, value: dv.getInt32(p) }; p += 4; break
      case TAG.FLOAT: cp[i] = { tag, value: dv.getFloat32(p) }; p += 4; break
      case TAG.LONG: cp[i] = { tag, value: dv.getBigInt64(p) }; p += 8; i++; break
      case TAG.DOUBLE: cp[i] = { tag, value: dv.getFloat64(p) }; p += 8; i++; break
      case TAG.CLASS: cp[i] = { tag, nameIndex: u2() }; break
      case TAG.STRING: cp[i] = { tag, utf8Index: u2() }; break
      case TAG.FIELDREF:
      case TAG.METHODREF:
      case TAG.IFACE_METHODREF:
        cp[i] = { tag, classIndex: u2(), natIndex: u2() }; break
      case TAG.NAMEANDTYPE: cp[i] = { tag, nameIndex: u2(), descIndex: u2() }; break
      case TAG.METHODHANDLE: cp[i] = { tag, kind: u1(), refIndex: u2() }; break
      case TAG.METHODTYPE: cp[i] = { tag, descIndex: u2() }; break
      case TAG.DYNAMIC:
      case TAG.INVOKEDYNAMIC:
        cp[i] = { tag, bootstrapIndex: u2(), natIndex: u2() }; break
      case TAG.MODULE:
      case TAG.PACKAGE:
        cp[i] = { tag, nameIndex: u2() }; break
      default: throw new Error("unknown cp tag " + tag + " at " + i)
    }
  }

  const utf = (i) => cp[i]?.value
  const strVal = (i) => cp[i]?.tag === TAG.STRING ? utf(cp[i].utf8Index) : undefined
  const className = (i) => cp[i]?.tag === TAG.CLASS ? utf(cp[i].nameIndex) : undefined
  const methodName = (i) => {
    const ref = cp[i]
    if (!ref || (ref.tag !== TAG.METHODREF && ref.tag !== TAG.IFACE_METHODREF)) return undefined
    return utf(cp[ref.natIndex].nameIndex)
  }
  // Fieldref/Methodref -> { cls, name, desc }
  const memberRef = (i) => {
    const ref = cp[i]
    if (!ref || (ref.tag !== TAG.FIELDREF && ref.tag !== TAG.METHODREF && ref.tag !== TAG.IFACE_METHODREF)) return undefined
    const nat = cp[ref.natIndex]
    return { cls: className(ref.classIndex), name: utf(nat.nameIndex), desc: utf(nat.descIndex) }
  }
  // ldc/ldc_w/ldc2_w operand -> JS number/string, undefined for other kinds
  const constVal = (i) => {
    const c = cp[i]
    if (!c) return undefined
    if (c.tag === TAG.INTEGER || c.tag === TAG.FLOAT || c.tag === TAG.DOUBLE) return c.value
    if (c.tag === TAG.LONG) return Number(c.value)
    if (c.tag === TAG.STRING) return utf(c.utf8Index)
    return undefined
  }

  u2(); u2(); u2() // access, this, super
  const ifCount = u2(); p += ifCount * 2

  const readMembers = () => {
    const n = u2()
    const out = []
    for (let i = 0; i < n; i++) {
      const access = u2(), nameIdx = u2(), descIdx = u2()
      const attrs = readAttributes()
      out.push({ access, name: utf(nameIdx), desc: utf(descIdx), attrs })
    }
    return out
  }
  function readAttributes() {
    const n = u2()
    const out = []
    for (let i = 0; i < n; i++) {
      const nameIdx = u2(), len = u4()
      out.push({ name: utf(nameIdx), start: p, len })
      p += len
    }
    return out
  }

  const fields = readMembers()
  const methods = readMembers()

  return { cp, utf, strVal, className, methodName, memberRef, constVal, fields, methods, dv, buf }
}

// "(Lfoo;IZ)Lbar;" -> { args: ['L','I','Z'], ret: 'L' } (first char of each type)
export function parseDescriptor(desc) {
  const args = []
  let i = 1
  while (desc[i] !== ")") {
    const start = i
    while (desc[i] === "[") i++
    if (desc[i] === "L") { while (desc[i] !== ";") i++ }
    i++
    args.push(desc[start] === "[" ? "[" : desc[start])
  }
  const r = desc[i + 1]
  return { args, ret: r === "[" ? "[" : r, retClass: desc.slice(i + 2, -1) }
}

// Operand lengths in bytes after each opcode (wide/switches are special-cased in walkCode).
const OPLEN = (() => {
  const t = new Array(256).fill(0)
  const set = (list, n) => list.forEach((op) => (t[op] = n))
  set([0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a, 0xa9, 0xbc], 1)
  set([0x11, 0x13, 0x14, 0x84, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
       0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
       0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7], 2)
  set([0xc5], 3)
  set([0xb9, 0xba, 0xc8, 0xc9], 4)
  return t
})()

export function walkCode({ dv }, codeStart, codeLen, visit) {
  let p = codeStart
  const end = codeStart + codeLen
  while (p < end) {
    const op = dv.getUint8(p)
    const opAddr = p
    p += 1
    if (op === 0xc4) { // wide
      const wop = dv.getUint8(p)
      p += (wop === 0x84) ? 5 : 3 // iinc -> 5, others -> 3
      continue
    }
    if (op === 0xaa) { // tableswitch
      let pad = (4 - ((p - codeStart) % 4)) % 4; p += pad
      p += 4 // default
      const low = dv.getInt32(p); p += 4
      const high = dv.getInt32(p); p += 4
      p += (high - low + 1) * 4
      continue
    }
    if (op === 0xab) { // lookupswitch
      let pad = (4 - ((p - codeStart) % 4)) % 4; p += pad
      p += 4 // default
      const npairs = dv.getInt32(p); p += 4
      p += npairs * 8
      continue
    }
    const len = OPLEN[op]
    visit(op, p, opAddr)
    p += len
  }
}

export function findCode(cls, name, desc) {
  const m = cls.methods.find((m) => m.name === name && (!desc || m.desc === desc))
  if (!m) return null
  const code = m.attrs.find((a) => a.name === "Code")
  if (!code) return null
  const dv = cls.dv
  let p = code.start
  p += 2 + 2 // max_stack, max_locals
  const codeLen = dv.getUint32(p); p += 4
  return { codeStart: p, codeLen }
}

function utf8(bytes) {
  // Java modified UTF-8 is standard UTF-8 for the ASCII names we read here.
  return new TextDecoder("utf-8").decode(bytes)
}
