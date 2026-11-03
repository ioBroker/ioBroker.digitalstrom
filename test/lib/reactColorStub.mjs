// Stands in for react-color while the tests load GenericApp in Node. adapter-react-v5 imports
// ChromePicker by name from that CommonJS package; Node 24 detects the export, Node 22 does not and
// refuses to load the module. The configuration dialog never shows a colour picker.
export const ChromePicker = () => null;

export default { ChromePicker };
