import { Fetch, JsonErrorMsg } from "@/app/utils/fetching";
import { Button, Checkbox, Colors, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, Icon, InputGroup, Label, NonIdealState, Spinner } from "@blueprintjs/core";
import { useEffect, useMemo, useState } from "react";
import { DeviceState, FFT, FFTDiff, ProjectDeviceDetails, ProjectInfo, fetchAllProjects, fetchProjectDiff, isProjectSubmitted, parseFftFieldNameFromFftDiff, parseFftIdFromFftDiff } from "../project_model";


// this dialog is used for filtering the table (fc, fg, and based on state)
export const FilterFFTDialog: React.FC<{ isOpen: boolean, possibleStates: DeviceState[], onClose: () => void, onSubmit: (newFcFilter: string, newFgFilter: string, newStateFilter: string) => void }> = ({ isOpen, possibleStates, onClose, onSubmit }) => {
    const [fcFilter, setFcFilter] = useState('');
    const [fgFilter, setFgFilter] = useState('');
    const [stateFilter, setStateFilter] = useState('');

    const submitSearchForm = () => {
        onSubmit(fcFilter, fgFilter, stateFilter);
    }

    const submitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            submitSearchForm();
        }
    }

    const availableStates = useMemo(() => {
        return ["---- Any ----", ...possibleStates.map(s => s.name)];
    }, [possibleStates])

    return (
        <Dialog isOpen={isOpen} onClose={onClose} title="Apply Filter to Table" autoFocus={true}>
            <DialogBody useOverflowScrollContainer>
                <FormGroup label="FC:" labelFor="fc-filter">
                    <InputGroup id="fc-filter"
                        placeholder="Use GLOB pattern to filter on FC name"
                        value={fcFilter}
                        onKeyUp={submitOnEnter}
                        onValueChange={(val: string) => setFcFilter(val)} />
                </FormGroup>

                <FormGroup label="FG:" labelFor="fg-filter">
                    <InputGroup id="fg-filter"
                        placeholder="Use GLOB pattern to filter on FG name"
                        value={fgFilter}
                        onKeyUp={submitOnEnter}
                        onValueChange={(val: string) => setFgFilter(val)} />
                </FormGroup>

                <FormGroup label="State:" labelFor="state-filter">
                    <HTMLSelect id="state-filter"
                        value={stateFilter}
                        options={availableStates}
                        onChange={(e) => setStateFilter(e.currentTarget.value)}
                        fill={true} iconName="caret-down" />
                </FormGroup>
            </DialogBody>
            <DialogFooter actions={
                <>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button onClick={(e) => submitSearchForm()} intent="primary">Search</Button>
                </>
            }>
            </DialogFooter>
        </Dialog>
    )
}



// this dialog is used to copy the fft setting to a different project
export const CopyFFTToProjectDialog: React.FC<{ isOpen: boolean, currentProject: ProjectInfo, FFT: FFT, onClose: () => void, onSubmit: (updatedDeviceData: ProjectDeviceDetails) => void }> = ({ isOpen, currentProject, FFT, onClose, onSubmit }) => {
    const DEFAULT_PROJECT = "Please select a project"
    const [availableProjects, setAvailableProjects] = useState<ProjectInfo[]>([]);
    const [projectNames, setProjectNames] = useState<string[]>([DEFAULT_PROJECT]);
    const [selectedProject, setSelectedProject] = useState<string>(DEFAULT_PROJECT);

    const [dialogErr, setDialogErr] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const [missingFFTOnOtherProject, setMissingFFTOnOtherProject] = useState(false);
    const [changedFFTs, setChangedFFTs] = useState<FFTDiff[]>([]);
    const [fetchingProjectDiff, setFetchingProjectDiff] = useState(false);
    const [fftDiffSelection, setFftDiffSelection] = useState<boolean[]>([]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        fetchAllProjects()
            .then((projects) => {
                let allProjects = projects.filter(p => isProjectSubmitted(p)).filter(p => p.name !== currentProject.name);
                setAvailableProjects(allProjects);
                setProjectNames([DEFAULT_PROJECT, ...allProjects.map(p => p.name)]);
                setDialogErr("");
            }).catch((err) => {
                console.error("failed to fetch project data:", err);
                let e = err as JsonErrorMsg;
                let msg = `Failed to fetch project data: ${e.error}`;
                setDialogErr(msg);
            })
    }, [isOpen]);


    // query for fft changes between chosen from/to projects
    useEffect(() => {
        if (!isOpen) {
            return;
        }

        if (selectedProject === DEFAULT_PROJECT) {
            setChangedFFTs([]);
            return;
        }

        let newProject = availableProjects.filter(p => p.name === selectedProject)[0];
        // query if there is any change between fft of selected project 
        // and fft of a new project 
        // 
        // We should be able to abort the query if necessary 
        setFetchingProjectDiff(true);
        fetchProjectDiff(currentProject._id, newProject._id)
            .then(diff => {
                let diffsToShow = diff.filter(d => d.diff === true && parseFftIdFromFftDiff(d) === FFT._id);

                // it's possible that the other project does not have this fftid; the backend does not
                // throw an error in this case, and we have to handle this case manually. 
                // It only happens if one of the names of fft field starts with "fft.<_id>|<fc>|<fg>"
                let otherProjectDoesNotHaveFFT = diffsToShow.some(obj => parseFftFieldNameFromFftDiff(obj).startsWith("fft."))
                if (otherProjectDoesNotHaveFFT) {
                    setMissingFFTOnOtherProject(true);
                    setChangedFFTs([]);
                    setDialogErr("");
                    return;
                }

                setMissingFFTOnOtherProject(false);
                setChangedFFTs(diffsToShow);
                setDialogErr("");
            }).catch(err => {
                console.error("Failed to fetch project diff: ", err);
                let e = err as JsonErrorMsg;
                setDialogErr("Failed to fetch project diff: " + e.error);
            }).finally(() => {
                setFetchingProjectDiff(false);
            })
    }, [selectedProject, FFT, isOpen])

    // clear the checkboxes whenever fft diff changes
    useEffect(() => {
        let changed = changedFFTs.map(f => false);
        setFftDiffSelection(changed);
    }, [changedFFTs])

    const numOfFFTChanges = useMemo(() => {
        let count = 0;
        for (let selected of fftDiffSelection) {
            if (selected) {
                count++;
            }
        }
        return count
    }, [fftDiffSelection]);


    // button submit action
    const submit = () => {
        if (selectedProject === DEFAULT_PROJECT) {
            setDialogErr("Invalid project selected");
            return;
        }

        if (changedFFTs.length == 0) {
            // this should never happen
            setDialogErr("Can't copy from unknown changed ffts: this is a programming bug");
            return;
        }

        setSubmitting(true);

        const project = availableProjects.filter(p => p.name == selectedProject)[0];
        const projectIdToCopyFrom = project._id;
        const attributeNames = changedFFTs.filter((f, i) => {
            if (fftDiffSelection[i]) {
                // this field/value was selected for copying by the end user via a checkbox
                return true;
            }
            return false;
        }).map(diff => parseFftFieldNameFromFftDiff(diff));
        let data = { 'other_id': projectIdToCopyFrom, 'attrnames': attributeNames }

        const projectIdToCopyTo = currentProject._id;
        const fftIdToCopyTo = FFT._id;
        Fetch.post<ProjectDeviceDetails>(`/ws/projects/${projectIdToCopyTo}/ffts/${fftIdToCopyTo}/copy_from_project`,
            { body: JSON.stringify(data) }
        ).then(updatedDeviceData => {
            onSubmit(updatedDeviceData);
        }).catch((err) => {
            let e = err as JsonErrorMsg;
            let msg = `Failed to copy fft changes of ${FFT.fc}-${FFT.fg}: ${e.error}`;
            console.error(msg, err);
            setDialogErr(msg);
        }).finally(() => {
            setSubmitting(false);
        })
    }

    const allChangesAreSelected = numOfFFTChanges == fftDiffSelection.length;

    // render fft diff table
    const renderDiffTable = () => {
        if (selectedProject === DEFAULT_PROJECT) {
            return <NonIdealState icon={"search"} title="No Project Selected" description={"Please select a project"} />
        }

        if (fetchingProjectDiff) {
            return <NonIdealState icon={<Spinner />} title="Loading" description={'Please Wait'} />
        }

        if (missingFFTOnOtherProject) {
            return <NonIdealState icon={'warning-sign'} title="Missing FFT" description={`${FFT.fc}-${FFT.fg} does not exist on selected project ${selectedProject}`} />
        }

        if (changedFFTs.length == 0) {
            // there is no fft difference between projects
            return <NonIdealState icon={"clean"} title="No Changes" description={"All FFT values are equal between compared projects"} />
        }

        return (
            <>
                <h6>FFT Value Changes:</h6>
                <table className="table table-bordered table-striped table-sm">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Current Value</th>
                            <th></th>
                            <th>New Value</th>
                            <th>
                                <Checkbox className="table-checkbox"
                                    checked={allChangesAreSelected}
                                    onChange={(e) => {
                                        if (allChangesAreSelected) {
                                            let unselectAll = fftDiffSelection.map(_ => false);
                                            setFftDiffSelection(unselectAll);
                                        } else {
                                            let selectAll = fftDiffSelection.map(_ => true);
                                            setFftDiffSelection(selectAll);
                                        }
                                    }
                                    } />
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {changedFFTs.map((change, i) => {
                            return (<tr key={change.key}>
                                <td>{parseFftFieldNameFromFftDiff(change)}</td>
                                <td>{change.my}</td>
                                <td className="text-center"><Icon icon="arrow-right" color={Colors.GRAY1}></Icon></td>
                                <td>{change.ot}</td>
                                <td>
                                    {/* note: leave the comparison === true, otherwise the React will complain about controlled
                                and uncontrolled components. I think this is a bug in the library and not the issue with our code,
                                since our usage of controlled component is correct here */}
                                    <Checkbox className="table-checkbox"
                                        checked={fftDiffSelection[i] === true} value={''}
                                        onChange={(e) => {
                                            let newSelection = [...fftDiffSelection];
                                            newSelection[i] = !fftDiffSelection[i];
                                            setFftDiffSelection(newSelection);
                                        }
                                        } />
                                </td>
                            </tr>)
                        })
                        }
                    </tbody>
                </table>
            </>
        )
    }

    return (
        <Dialog isOpen={isOpen} onClose={onClose} title={`Copy FFT Changes to "${currentProject.name}"`} autoFocus={true} style={{ width: "45rem" }}>
            <DialogBody useOverflowScrollContainer>
                <table className="table table-sm table-borderless table-nohead table-nobg m-0 mb-2">
                    <thead>
                        <tr>
                            <th></th>
                            <th className="w-100"></th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><Label className="text-end mb-1">FFT:</Label></td>
                            <td>{FFT.fc}-{FFT.fg}</td>
                        </tr>
                        <tr>
                            <td><Label className="text-nowrap text-end mb-1" htmlFor="project-select">Copy From Project:</Label></td>
                            <td>
                                <HTMLSelect id="project-select"
                                    value={selectedProject}
                                    options={projectNames}
                                    onChange={(e) => setSelectedProject(e.currentTarget.value)}
                                    disabled={fetchingProjectDiff}
                                    fill={false} iconName="caret-down" />
                            </td>
                        </tr>
                        <tr>
                            <td><Label className="text-end mb-1">Copy To Project:</Label></td>
                            <td>{currentProject.name}</td>
                        </tr>
                    </tbody>
                </table>

                <hr />

                {renderDiffTable()}

            </DialogBody>
            <DialogFooter actions={
                <>
                    <Button onClick={onClose}>Close</Button>
                    <Button onClick={(e) => submit()} intent="primary" loading={submitting} disabled={selectedProject === DEFAULT_PROJECT || numOfFFTChanges === 0}>Copy {numOfFFTChanges} {numOfFFTChanges == 1 ? "Change" : "Changes"} to {currentProject.name}</Button>
                </>
            }>
                {dialogErr ? <span className="error">ERROR: {dialogErr}</span> : null}
            </DialogFooter>
        </Dialog >
    )
}