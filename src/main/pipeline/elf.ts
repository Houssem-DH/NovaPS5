import fs from 'fs'

// PS5 SELF container magics and the plain ELF / PE magics we care about.
// The second form is the "kernel" SELF variant (unwrap_self.py's
// SELF_MAGIC_KERNEL = 0xEEF51454) — e.g. Aeterna Noctis ships its eboot
// this way; the relinker recognizes both too.
const SELF_MAGIC = Buffer.from([0x4f, 0x15, 0x3d, 0x1d])
const SELF_KERNEL_MAGIC = Buffer.from([0x54, 0x14, 0xf5, 0xee])
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const PE_MAGIC = Buffer.from([0x4d, 0x5a]) // "MZ"

export type ContainerKind = 'self' | 'elf' | 'pe' | 'unknown'

/** Read the first few bytes of a file and classify the container format. */
export function detectContainer(file: string): ContainerKind {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(4)
    const read = fs.readSync(fd, buf, 0, 4, 0)
    if (read < 2) return 'unknown'
    if (buf.subarray(0, 4).equals(ELF_MAGIC)) return 'elf'
    if (buf.subarray(0, 4).equals(SELF_MAGIC) || buf.subarray(0, 4).equals(SELF_KERNEL_MAGIC)) return 'self'
    if (buf.subarray(0, 2).equals(PE_MAGIC)) return 'pe'
    return 'unknown'
  } catch {
    return 'unknown'
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

export interface ElfDynamicInfo {
  /** DT_NEEDED entries, in declaration order. */
  needed: string[]
  /** DT_SONAME, or null when the file does not declare one. */
  soname: string | null
}

/**
 * Read the dynamic section of a *plain* ELF (pass an unwrapped file — SELF
 * containers carry the ELF header at an offset and cannot be parsed here).
 *
 * The relinker treats every ELF file inside a module folder as a guest module
 * and reconciles them by filename + SONAME, so this lets the pipeline predict
 * exactly which modules will collide before handing them over. Returns null
 * when the file cannot be parsed as a little-endian ELF.
 */
export function readElfDynamicInfo(file: string): ElfDynamicInfo | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(64)
    if (fs.readSync(fd, head, 0, 64, 0) < 52) return null
    if (!head.subarray(0, 4).equals(ELF_MAGIC)) return null
    // PS4/PS5 binaries are always little-endian; refuse anything else rather
    // than decoding nonsense offsets.
    if (head[5] !== 1) return null
    const is64 = head[4] === 2
    const phoff = Number(is64 ? head.readBigUInt64LE(32) : head.readUInt32LE(28))
    const phentsize = head.readUInt16LE(is64 ? 54 : 42)
    const phnum = head.readUInt16LE(is64 ? 56 : 44)
    if (phnum === 0 || phnum > 1024 || phentsize < (is64 ? 56 : 32)) return null

    const loads: Array<{ vaddr: number; off: number; filesz: number }> = []
    let dynOff = -1
    let dynSize = 0

    const phdr = Buffer.alloc(phentsize)
    for (let i = 0; i < phnum; i++) {
      if (fs.readSync(fd, phdr, 0, phentsize, phoff + i * phentsize) < phentsize) return null
      const type = phdr.readUInt32LE(0)
      if (is64) {
        const off = Number(phdr.readBigUInt64LE(8))
        const vaddr = Number(phdr.readBigUInt64LE(16))
        const filesz = Number(phdr.readBigUInt64LE(32))
        if (type === 1) loads.push({ vaddr, off, filesz })
        else if (type === 2) {
          dynOff = off
          dynSize = filesz
        }
      } else {
        const off = phdr.readUInt32LE(4)
        const vaddr = phdr.readUInt32LE(8)
        const filesz = phdr.readUInt32LE(16)
        if (type === 1) loads.push({ vaddr, off, filesz })
        else if (type === 2) {
          dynOff = off
          dynSize = filesz
        }
      }
    }
    // Statically linked (or stripped) ELF: no dynamic section, no imports.
    if (dynOff < 0 || dynSize <= 0) return { needed: [], soname: null }

    const vaddrToOff = (vaddr: number): number => {
      for (const load of loads) {
        if (vaddr >= load.vaddr && vaddr < load.vaddr + load.filesz) {
          return load.off + (vaddr - load.vaddr)
        }
      }
      return -1
    }

    const entrySize = is64 ? 16 : 8
    const dyn = Buffer.alloc(Math.min(dynSize, entrySize * 4096))
    const dynRead = fs.readSync(fd, dyn, 0, dyn.length, dynOff)
    if (dynRead < entrySize) return { needed: [], soname: null }
    const tags: Array<{ tag: number; val: number }> = []
    for (let o = 0; o + entrySize <= dynRead; o += entrySize) {
      const tag = is64 ? Number(dyn.readBigInt64LE(o)) : dyn.readInt32LE(o)
      if (tag === 0) break // DT_NULL
      const val = is64 ? Number(dyn.readBigUInt64LE(o + 8)) : dyn.readUInt32LE(o + 4)
      tags.push({ tag, val })
    }

    const strtabVal = tags.find((t) => t.tag === 5)?.val // DT_STRTAB
    if (strtabVal === undefined) return { needed: [], soname: null }
    const strOff = vaddrToOff(strtabVal)
    if (strOff < 0) return null
    const strsz = tags.find((t) => t.tag === 10)?.val ?? 65536 // DT_STRSZ
    const strtab = Buffer.alloc(Math.min(strsz, 4 << 20))
    const strRead = fs.readSync(fd, strtab, 0, strtab.length, strOff)
    if (strRead <= 0) return null

    const stringAt = (offset: number): string | null => {
      if (offset < 0 || offset >= strRead) return null
      const end = strtab.indexOf(0, offset)
      const name = strtab.subarray(offset, end === -1 ? strRead : end).toString('latin1')
      return name || null
    }

    const needed: string[] = []
    for (const { tag, val } of tags) {
      if (tag !== 1) continue // DT_NEEDED
      const name = stringAt(val)
      if (name) needed.push(name)
    }
    const sonameTag = tags.find((t) => t.tag === 14) // DT_SONAME
    const soname = sonameTag ? stringAt(sonameTag.val) : null

    return { needed, soname }
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * First four bytes as hex (e.g. "4F 15 3D 1D") — used in compatibility
 * messages so an unidentified file can be diagnosed at a glance.
 */
export function readMagicHex(file: string): string {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(4)
    const read = fs.readSync(fd, buf, 0, 4, 0)
    if (read <= 0) return 'empty'
    return Array.from(buf.subarray(0, read))
      .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ')
  } catch {
    return 'unreadable'
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}
