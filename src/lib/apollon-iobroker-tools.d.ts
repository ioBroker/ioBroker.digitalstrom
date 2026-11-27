// @apollon/iobroker-tools ships no types. Only the part of it this adapter actually uses is
// written down here.

declare module '@apollon/iobroker-tools' {
    /**
     * The objectHelper of `@apollon/iobroker-tools`. It keeps its adapter reference, the object
     * queue, the known objects and the state change callbacks in module scope.
     */
    export interface ObjectHelper {
        /** Binds the helper to an adapter instance */
        init(adapter: any): void;
        /** Queues an object for creation or update */
        setOrUpdateObject(
            id: string,
            obj: any,
            obtainCustomFields: string[],
            value?: any,
            stateChangeCallback?: (value: any) => void,
            createNow?: boolean,
        ): void;
        /** Writes the queued objects and their values */
        processObjectQueue(callback?: () => void): void;
        /** Fills existingStates with the objects that already exist for this instance */
        loadExistingObjects(callback?: () => void): void;
        /** Routes an unacknowledged state change to the onChange handler of that object */
        handleStateChange(id: string, state: ioBroker.State): void;
        /** Objects of this instance, the ones left over after registerObjects() are the unknown ones */
        existingStates: Record<string, any>;
    }

    /** The helper shared by everybody who loads the package */
    export const objectHelper: ObjectHelper;
}

declare module '@apollon/iobroker-tools/lib/objectHelper' {
    import type { ObjectHelper } from '@apollon/iobroker-tools';

    const objectHelper: ObjectHelper;
    export = objectHelper;
}
