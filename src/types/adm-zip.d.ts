declare module 'adm-zip' {
  interface AdmZip {
    extractAllTo(targetPath: string, overwrite: boolean): void;
    getEntries(): AdmZipEntry[];
    /** Returns the entry with the given name, or null. */
    getEntry(name: string): AdmZipEntry | null;
  }
  interface AdmZipEntry {
    entryName: string;
    isDirectory: boolean;
    /** Decompressed content of the entry. */
    getData(): Buffer;
  }
  class AdmZip {
    /** Accepts a zip file path or the archive bytes themselves (a Buffer
     *  works for any extension and avoids adm-zip's existsSync quirks). */
    constructor(zipPath: string | Buffer);
    extractAllTo(targetPath: string, overwrite: boolean): void;
    getEntries(): AdmZipEntry[];
    getEntry(name: string): AdmZipEntry | null;
  }
  export default AdmZip;
}
