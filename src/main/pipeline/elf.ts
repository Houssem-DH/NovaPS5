import fs from 'fs'

// PS5 SELF container magic and the plain ELF / PE magics we care about.
const SELF_MAGIC = Buffer.from([0x4f, 0x15, 0x3d, 0x1d])
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
    if (buf.subarray(0, 4).equals(SELF_MAGIC)) return 'self'
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
