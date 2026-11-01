import stripAnsi from 'strip-ansi';
/** Keep arbitrary source/model output from sending terminal control sequences. */
export const safeText = (text: string): string => stripAnsi(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
export const modelName = (id: string): string => safeText(id).split('/').at(-1)!;
