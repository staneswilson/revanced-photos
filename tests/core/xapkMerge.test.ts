import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mergeXapkToApk, XapkMergeError } from '../../src/core/xapkMerge.js';
import * as child_process from 'child_process';

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, options, callback) => {
    callback(null, 'Merging splits...\nDone', '');
  }),
}));

describe('xapkMerge', () => {
  beforeEach(() => {
    vi.mocked(child_process.execFile).mockClear();
  });

  afterEach(() => {
    delete process.env.APKEDITOR_JAR;
  });

  it('invokes APKEditor with `m -i <xapk> -o <apk> -f`', async () => {
    process.env.APKEDITOR_JAR = '/opt/APKEditor.jar';
    await mergeXapkToApk('/tmp/photos.xapk', '/tmp/input.apk');

    expect(child_process.execFile).toHaveBeenCalledWith(
      'java',
      ['-jar', '/opt/APKEditor.jar', 'm', '-i', '/tmp/photos.xapk', '-o', '/tmp/input.apk', '-f'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('throws XapkMergeError with a helpful message when APKEDITOR_JAR is unset', async () => {
    delete process.env.APKEDITOR_JAR;
    await expect(mergeXapkToApk('/tmp/photos.xapk', '/tmp/input.apk')).rejects.toThrowError(
      XapkMergeError,
    );
  });

  it('wraps APKEditor failures in XapkMergeError with the stderr snippet', async () => {
    process.env.APKEDITOR_JAR = '/opt/APKEditor.jar';
    vi.mocked(child_process.execFile).mockImplementationOnce(
      (cmd, args, options, callback: any) => {
        const err: any = new Error('Process exited with code 1');
        err.stderr = 'java.lang.Exception: corrupt zip entry';
        callback(err, '', err.stderr);
      },
    );

    await expect(mergeXapkToApk('/tmp/photos.xapk', '/tmp/input.apk')).rejects.toThrowError(
      /corrupt zip entry/,
    );
  });
});
