declare module 'adm-zip' {
  interface AdmZip {
    extractAllTo(targetPath: string, overwrite: boolean): void;
    getEntries(): AdmZipEntry[];
  }
  interface AdmZipEntry {
    entryName: string;
    isDirectory: boolean;
  }
  class AdmZip {
    constructor(zipPath: string);
    extractAllTo(targetPath: string, overwrite: boolean): void;
    getEntries(): AdmZipEntry[];
  }
  export default AdmZip;
}
