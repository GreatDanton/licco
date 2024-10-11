import { HtmlPage } from "@/app/components/html_page";
import { Fetch, JsonErrorMsg } from "@/app/utils/fetching";
import { createGlobMatchRegex } from "@/app/utils/glob_matcher";
import { Button, ButtonGroup, Colors, Divider, HTMLSelect, Icon, InputGroup, NonIdealState, NumericInput, Tooltip } from "@blueprintjs/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Dispatch, SetStateAction, useEffect, useMemo, useState } from "react";
import { ProjectApprovalDialog } from "../project_approval_dialog";
import { DeviceState, FFT, ProjectDeviceDetails, ProjectInfo, isProjectSubmitted } from "../project_model";
import { CopyFFTToProjectDialog, FilterFFTDialog } from "./project_dialogs";


const formatDevicePositionNumber = (value?: number | string): string => {
    if (value === undefined) {
        return '';
    }
    if (typeof value === "string") {
        return value;
    }
    return value.toFixed(7);
}

// a project specific page displays all properties of a specific project 
export const ProjectSpecificPage: React.FC<{ projectId: string }> = ({ projectId }) => {
    // page and url info
    const router = useRouter();
    const pathName = usePathname();
    const queryParams = useSearchParams();

    // data and loading
    const [isLoading, setIsLoading] = useState(false);
    const [fftDataLoadingError, setFftDataLoadingError] = useState('');
    const [projectData, setProjectData] = useState<ProjectInfo>();
    const [fftData, setFftData] = useState<ProjectDeviceDetails[]>([]);
    const [fftDataDisplay, setFftDataDisplay] = useState<ProjectDeviceDetails[]>([]);

    // dialogs open state
    const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);
    const [isApprovalDialogOpen, setIsApprovalDialogOpen] = useState(false);
    const [isCopyFFTDialogOpen, setIsCopyFFTDialogOpen] = useState(false);
    const [currentFFT, setCurrentFFT] = useState<FFT>({ _id: "", fc: "", fg: "" });

    // filters to apply
    const [fcFilter, setFcFilter] = useState("");
    const [fgFilter, setFgFilter] = useState("");
    const [availableFftStates, setAvailableFftStates] = useState<DeviceState[]>(DeviceState.allStates);
    const [stateFilter, setStateFilter] = useState("");
    const [showFftSinceCreationFilter, setShowFftSinceCreationFilter] = useState(false);

    // state suitable for row updates
    const [editedDevice, setEditedDevice] = useState<ProjectDeviceDetails>();



    const loadFFTData = (projectId: string, showAllEntries: boolean = true): Promise<void | ProjectDeviceDetails[]> => {
        setIsLoading(true);
        setFftDataLoadingError('');
        return Fetch.get<Record<string, ProjectDeviceDetails>>(`/ws/projects/${projectId}/ffts/?showallentries=${showAllEntries}`)
            .then((data) => {
                // TODO: missing device number field is set to "" (empty string):
                // we should turn it into an null to avoid having problems when formatting it later
                let devices = Object.values(data);
                setFftData(devices);
                return devices;
            }).catch((e) => {
                console.error("Failed to load device data:", e);
                let err = e as JsonErrorMsg;
                let msg = `Failed to load device data: ${err.error}`;
                setFftData([]);
                setFftDataLoadingError(msg);
            }).finally(() => {
                setIsLoading(false);
            });
    }

    // load project data on load
    useEffect(() => {
        setIsLoading(true);
        {
            // set filters based on query params
            setFcFilter(queryParams.get("fc") ?? "");
            setFgFilter(queryParams.get("fg") ?? "");
            setStateFilter(queryParams.get("state") ?? "");
        }

        Fetch.get<ProjectInfo>(`/ws/projects/${projectId}/`)
            .then(data => {
                setProjectData(data);
            }).catch((e) => {
                console.error("Failed to make a project request");
            });

        let showAllEntries = true;
        loadFFTData(projectId, showAllEntries);
    }, []);

    // get unique fft states for filter dialog
    // useEffect(() => {
    //     let uniqueStates = Array.from(new Set(fftData.map((e) => e.state).filter(state => state)));
    //     setAvailableFftStates(uniqueStates);
    // }, [fftData])

    // apply table filters, when any filter or original data changes
    useEffect(() => {
        let fcGlobMatcher = createGlobMatchRegex(fcFilter)
        let fgGlobMatcher = createGlobMatchRegex(fgFilter);
        let filteredFftData = fftData.filter(d => {
            if (fcFilter) {
                return fcGlobMatcher.test(d.fft.fc);
            }
            return true;
        }).filter(d => {
            if (fgFilter) {
                return fgGlobMatcher.test(d.fft.fg);
            }
            return true;
        }).filter(d => {
            if (stateFilter) {
                return d.state === stateFilter;
            }
            return true;
        })
        setFftDataDisplay(filteredFftData);
    }, [fftData, fcFilter, fgFilter, stateFilter]);


    const displayFilterIconInColumn = (filterValue: string) => {
        if (!filterValue) {
            return null
        }
        return <Icon icon="filter" color={Colors.RED2} className="ms-1" />
    }

    const updateQueryParams = (fcFilter: string, fgFilter: string, stateFilter: string) => {
        const params = new URLSearchParams();
        if (fcFilter) {
            params.set("fc", fcFilter);
        }
        if (fgFilter) {
            params.set("fg", fgFilter);
        }
        if (stateFilter) {
            params.set("state", stateFilter);
        }
        router.replace(`${pathName}?${params.toString()}`)
    }

    const isProjectSubmitted = projectData?.status === "submitted";
    const isFilterApplied = fcFilter != "" || fgFilter != "" || stateFilter != "" || showFftSinceCreationFilter;
    const isEditedTable = editedDevice != undefined;

    return (
        <HtmlPage>
            {fftDataLoadingError ? <NonIdealState className="mb-4 mt-4" icon="error" title="Error" description={fftDataLoadingError} /> : null}

            {/* NOTE: horizontally scrollable table with sticky header only works if it's max height is capped */}
            <div className="table-responsive" style={{ maxHeight: 'calc(100vh - 130px)' }}>
                <table className="table table-bordered table-sm table-sticky table-striped">
                    <thead>
                        <tr>
                            <th colSpan={6}>
                                {!projectData ? <></> :
                                    <ButtonGroup vertical={false} className={isEditedTable ? "table-disabled" : ''}>

                                        <span className="me-3">{projectData?.name}</span>

                                        <Tooltip content="Download data to this project" position="bottom">
                                            <Button icon="import" minimal={true} small={true}></Button>
                                        </Tooltip>

                                        <Tooltip content="Upload data to this project" position="bottom">
                                            <Button icon="export" minimal={true} small={true}></Button>
                                        </Tooltip>

                                        <Divider />

                                        <Tooltip content="Filter FFTs" position="bottom">
                                            <Button icon="filter" minimal={true} small={true} intent={isFilterApplied ? "warning" : "none"} onClick={(e) => setIsFilterDialogOpen(true)}></Button>
                                        </Tooltip>

                                        <Tooltip content={"Clear filters to show all FFTs"} position="bottom" disabled={!isFilterApplied}>
                                            <Button icon="filter-remove" minimal={true} small={true} disabled={!isFilterApplied}
                                                onClick={(e) => {
                                                    setFcFilter('')
                                                    setFgFilter('');
                                                    setStateFilter('');
                                                    setShowFftSinceCreationFilter(false);
                                                    updateQueryParams('', '', '');
                                                }}
                                            />
                                        </Tooltip>

                                        <Tooltip content="Show only FCs with changes after the project was created" position="bottom">
                                            <Button icon="filter-open" minimal={true} small={true} intent={showFftSinceCreationFilter ? "warning" : "none"}
                                                onClick={(e) => {
                                                    if (showFftSinceCreationFilter) {
                                                        // filter is applied, therefore we have to toggle it off and show all entries
                                                        loadFFTData(projectId, true);
                                                    } else {
                                                        // filter is not applied, therefore we have to display changes after project was created
                                                        loadFFTData(projectId, false);
                                                    }

                                                    // toggle the filter flag 
                                                    setShowFftSinceCreationFilter(show => !show);
                                                }}
                                            ></Button>
                                        </Tooltip>

                                        <Divider />

                                        <Tooltip content="Create a tag" position="bottom">
                                            <Button icon="tag-add" minimal={true} small={true}></Button>
                                        </Tooltip>

                                        <Tooltip content="Show assigned tags" position="bottom">
                                            <Button icon="tags" minimal={true} small={true}></Button>
                                        </Tooltip>

                                        <Divider />

                                        <Tooltip content="Show the history of changes" position="bottom">
                                            <Button icon="history" minimal={true} small={true}></Button>
                                        </Tooltip>

                                        <Tooltip content={"Submit this project for approval"} position="bottom" disabled={isProjectSubmitted}>
                                            <Button icon="user" minimal={true} small={true}
                                                disabled={isProjectSubmitted}
                                                onClick={(e) => setIsApprovalDialogOpen(true)}
                                            />
                                        </Tooltip>
                                    </ButtonGroup>
                                }
                            </th>

                            <th colSpan={3} className="text-center">Nominal Location (meters in LCLS coordinates)</th>
                            <th colSpan={3} className="text-center">Nominal Dimension (meters)</th>
                            <th colSpan={3} className="text-center">Nominal Angle (radians)</th>
                            <th></th>
                        </tr>
                        <tr>
                            {isProjectSubmitted ? null : <th></th>}
                            <th>FC  {displayFilterIconInColumn(fcFilter)}</th>
                            <th>Fungible {displayFilterIconInColumn(fgFilter)}</th>
                            <th>TC Part No.</th>
                            <th>State {displayFilterIconInColumn(stateFilter)}</th>
                            <th>Comments</th>

                            <th className="text-center">Z</th>
                            <th className="text-center">X</th>
                            <th className="text-center">Y</th>

                            <th className="text-center">Z</th>
                            <th className="text-center">X</th>
                            <th className="text-center">Y</th>

                            <th className="text-center">Z</th>
                            <th className="text-center">X</th>
                            <th className="text-center">Y</th>
                            <th>Must Ray Trace</th>
                        </tr>
                    </thead>
                    <tbody>
                        {fftDataDisplay.map(device => {
                            const isEditedDevice = editedDevice == device;
                            const disableRow = isEditedTable && !isEditedDevice;
                            if (!isEditedDevice) {
                                return <DeviceDataTableRow key={device.fft._id} project={projectData} device={device} disabled={disableRow}
                                    onEdit={(device) => setEditedDevice(device)}
                                    onCopyFft={(device) => {
                                        setCurrentFFT(device.fft);
                                        setIsCopyFFTDialogOpen(true);
                                    }
                                    }
                                />
                            }

                            return <DeviceDataEditTableRow key={device.fft._id} project={projectData} device={device} availableFftStates={availableFftStates}
                                onEditDone={(updatedDeviceData, action) => {
                                    if (action == "cancel") {
                                        setEditedDevice(undefined);
                                        return;
                                    }

                                    // Do something with the updated device data, trigger an update
                                    console.log("==== UPDATED DEVICE DATA: ", updatedDeviceData);
                                    setEditedDevice(undefined);
                                }}
                            />
                        })
                        }
                    </tbody>
                </table>
            </div>

            {!isLoading && !fftDataLoadingError && !isFilterApplied && fftDataDisplay.length == 0 ?
                <NonIdealState icon="search" title="No FFTs Found" description={<>Project {projectData?.name} does not have any FFTs</>} />
                : null}

            {!isLoading && isFilterApplied && fftDataDisplay.length == 0 ?
                <NonIdealState icon="filter" title="No FFTs Found" description="Try changing your filters"></NonIdealState>
                : null
            }

            <FilterFFTDialog
                isOpen={isFilterDialogOpen}
                possibleStates={availableFftStates}
                onClose={() => setIsFilterDialogOpen(false)}
                onSubmit={(newFcFilter, newFgFilter, newStateFilter) => {
                    setFcFilter(newFcFilter);
                    setFgFilter(newFgFilter);
                    newStateFilter = newStateFilter.startsWith("---") ? "" : newStateFilter;
                    setStateFilter(newStateFilter);
                    updateQueryParams(newFcFilter, newFgFilter, newStateFilter);
                    setIsFilterDialogOpen(false);
                }}
            />

            {projectData ?
                <ProjectApprovalDialog
                    isOpen={isApprovalDialogOpen}
                    projectTitle={projectData.name}
                    projectId={projectData._id}
                    onClose={() => setIsApprovalDialogOpen(false)}
                    onSubmit={(projectInfo) => {
                        setProjectData(projectInfo);
                        setIsApprovalDialogOpen(false);
                    }}
                />
                : null}

            {projectData ?
                <CopyFFTToProjectDialog
                    isOpen={isCopyFFTDialogOpen}
                    FFT={currentFFT}
                    currentProject={projectData}
                    onClose={() => setIsCopyFFTDialogOpen(false)}
                    onSubmit={(newDeviceDetails) => {
                        // find current fft and update device details
                        let updatedData = [];
                        for (let d of fftData) {
                            if (d.fft._id != newDeviceDetails.fft._id) {
                                updatedData.push(d);
                                continue;
                            }
                            updatedData.push(newDeviceDetails);
                        }
                        setFftData(updatedData);
                        setIsCopyFFTDialogOpen(false);
                    }}
                /> : null}
        </HtmlPage >
    )
}


const DeviceDataTableRow: React.FC<{ project?: ProjectInfo, device: ProjectDeviceDetails, disabled: boolean, onEdit: (device: ProjectDeviceDetails) => void, onCopyFft: (device: ProjectDeviceDetails) => void }> = ({ project, device, disabled, onEdit, onCopyFft }) => {
    // we have to cache each table row, as once we have lots of rows in a table editing text fields within
    // becomes very slow due to constant rerendering of rows and their tooltips on every keystroke. 
    const row = useMemo(() => {
        return (
            <tr className={disabled ? 'table-disabled' : ''}>
                {isProjectSubmitted(project) ? null :
                    <td className="text-nowrap">
                        <Tooltip content={"Edit this FFT"} position="bottom">
                            <Button icon="edit" minimal={true} small={true}
                                onClick={(e) => onEdit(device)}
                            />
                        </Tooltip>
                        <Tooltip content={"Copy over the value from the currently approved project"} position="bottom">
                            <Button icon="refresh" minimal={true} small={true}
                                onClick={(e) => onCopyFft(device)}
                            />
                        </Tooltip>
                    </td>
                }

                <td>{device.fft.fc}</td>
                <td>{device.fft.fg}</td>
                <td> {device.tc_part_no}</td>
                <td>{device.state}</td>
                <td>{device.comments}</td>

                <td className="text-number">{formatDevicePositionNumber(device.nom_loc_z)}</td>
                <td className="text-number">{formatDevicePositionNumber(device.nom_loc_x)}</td>
                <td className="text-number">{formatDevicePositionNumber(device.nom_loc_y)}</td>

                <td className="text-number">{formatDevicePositionNumber(device.nom_dim_z)}</td>
                <td className="text-number">{formatDevicePositionNumber(device.nom_dim_x)}</td>
                <td className="text-number">{formatDevicePositionNumber(device.nom_dim_y)}</td>

                <td className="text-number">{formatDevicePositionNumber(device.nom_ang_z)}</td>
                <td className="text-number">{formatDevicePositionNumber(device.nom_ang_x)}</td>
                <td className="text-number">{formatDevicePositionNumber(device.nom_ang_y)}</td>

                <td>{device.ray_trace ?? null}</td>
            </tr>
        )
    }, [project, device, disabled])
    return row;
}


const DeviceDataEditTableRow: React.FC<{
    project?: ProjectInfo,
    device: ProjectDeviceDetails,
    availableFftStates: DeviceState[],
    onEditDone: (newDevice: ProjectDeviceDetails, action: "ok" | "cancel") => void
}> = ({ project, device, availableFftStates, onEditDone }) => {
    const [editTcPartNo, setEditTcPartNo] = useState<string>();
    const [editState, setEditState] = useState("");
    const [editComments, setEditComments] = useState('');
    const [editLocZ, setEditLocZ] = useState<string>();
    const [editLocX, setEditLocX] = useState<string>();
    const [editLocY, setEditLocY] = useState<string>();
    const [editDimZ, setEditDimZ] = useState<string>();
    const [editDimX, setEditDimX] = useState<string>();
    const [editDimY, setEditDimY] = useState<string>();
    const [editAngZ, setEditAngZ] = useState<string>();
    const [editAngX, setEditAngX] = useState<string>();
    const [editAngY, setEditAngY] = useState<string>();
    const [editMustRayTrace, setEditMustRayTrace] = useState<number>();

    useEffect(() => {
        setEditTcPartNo(device.tc_part_no);
        setEditState(device.state);
        setEditComments(device.comments);

        setEditLocX(device.nom_loc_x?.toString());
        setEditLocY(device.nom_loc_y?.toString());
        setEditLocZ(device.nom_loc_z?.toString());

        setEditDimX(device.nom_dim_x?.toString());
        setEditDimY(device.nom_dim_y?.toString());
        setEditDimZ(device.nom_dim_z?.toString());

        setEditAngX(device.nom_ang_x?.toString());
        setEditAngY(device.nom_ang_y?.toString());
        setEditAngZ(device.nom_ang_z?.toString());
        setEditMustRayTrace(device.ray_trace)
    }, [])

    const numberOrDefault = (value: string | undefined, defaultVal: number | undefined): number | undefined => {
        if (value == "" || value == undefined) {
            return undefined;
        }

        let num = Number.parseFloat(value);
        if (isNaN(num)) {
            // this should never happen since we verify the fields before the user 
            // is able to submit them. 
            return defaultVal;
        }
        return num;
    }

    const constructDevice = (): ProjectDeviceDetails => {
        let copyDevice = structuredClone(device);
        copyDevice.tc_part_no = editTcPartNo || '';
        copyDevice.comments = editComments;

        copyDevice.nom_loc_x = numberOrDefault(editLocX, undefined);
        copyDevice.nom_loc_y = numberOrDefault(editLocY, undefined);
        copyDevice.nom_loc_z = numberOrDefault(editLocZ, undefined);

        copyDevice.nom_dim_x = numberOrDefault(editDimX, undefined);
        copyDevice.nom_dim_y = numberOrDefault(editDimY, undefined);
        copyDevice.nom_dim_z = numberOrDefault(editDimZ, undefined);

        copyDevice.nom_ang_x = numberOrDefault(editAngX, undefined);
        copyDevice.nom_ang_y = numberOrDefault(editAngY, undefined);
        copyDevice.nom_ang_z = numberOrDefault(editAngZ, undefined);

        copyDevice.ray_trace = editMustRayTrace;
        return copyDevice;
    }

    interface NumericField {
        key: string;
        value: string | number | undefined;
        setter: any;
        err: [boolean, Dispatch<SetStateAction<boolean>>];
        min?: number;
        max?: number;
    }

    const numericFields: NumericField[] = [
        { key: 'nom_loc_z', value: editLocZ, setter: setEditLocZ, err: useState(false) },
        { key: 'nom_loc_x', value: editLocX, setter: setEditLocX, err: useState(false) },
        { key: 'nom_loc_y', value: editLocY, setter: setEditLocY, err: useState(false) },

        { key: 'nom_dim_z', value: editDimZ, setter: setEditDimZ, err: useState(false) },
        { key: 'nom_dim_x', value: editDimX, setter: setEditDimX, err: useState(false) },
        { key: 'nom_dim_y', value: editDimY, setter: setEditDimY, err: useState(false) },

        { key: 'nom_ang_z', value: editAngZ, setter: setEditAngZ, err: useState(false) },
        { key: 'nom_ang_x', value: editAngX, setter: setEditAngX, err: useState(false) },
        { key: 'nom_ang_y', value: editAngY, setter: setEditAngY, err: useState(false) },

        { key: 'ray_trace', value: editMustRayTrace, setter: setEditMustRayTrace, err: useState(false), max: 1, min: 0 }
    ]

    let errStates = numericFields.map(f => f.err[0]);
    const allFieldsAreValid = useMemo(() => {
        for (let f of numericFields) {
            if (f.err[0] === true) {
                return false;
            }
        }

        // all fields are valid, we can submit this change
        return true;
    }, [...errStates])

    let fftStates = useMemo(() => {
        return availableFftStates.map(s => s.name);
    }, [availableFftStates])

    return (
        <tr>
            {isProjectSubmitted(project) ? null :
                <td className="text-nowrap">
                    <Button icon="tick" minimal={true} small={true} title="Submit your edits"
                        disabled={!allFieldsAreValid}
                        onClick={(e) => onEditDone(constructDevice(), "ok")}
                    />

                    <Button icon="cross" minimal={true} small={true} title="Discard your edits"
                        onClick={(e) => onEditDone(constructDevice(), "cancel")}
                    />
                </td>
            }

            <td>{device.fft.fc}</td>
            <td>{device.fft.fg}</td>

            <td><InputGroup value={editTcPartNo || ''} onValueChange={(val) => setEditTcPartNo(val)} style={{ width: "auto", maxWidth: "12ch" }} /></td>
            <td> <HTMLSelect value={editState} options={fftStates} onChange={(e) => setEditState(e.target.value)} style={{ width: "auto" }} iconName="caret-down" /></td>
            <td><InputGroup value={editComments || ''} onValueChange={(val) => setEditComments(val)} style={{ width: "auto" }} /></td>

            {numericFields.map((field) => {
                return (
                    <td key={field.key}>
                        <NumericInput
                            buttonPosition="none"
                            allowNumericCharactersOnly={false}
                            intent={field.err[0] ? "danger" : "none"}
                            style={{ width: "auto", maxWidth: "15ch" }}
                            value={field.value?.toString() ?? ''}
                            onValueChange={(num, v) => {
                                field.setter(v);
                                if (isNaN(num)) {
                                    field.err[1](true);
                                    return;
                                }

                                // we have a valid number
                                field.err[1](false);

                                // check ranges if any 
                                if (field.min != undefined) {
                                    if (num < field.min) {
                                        field.err[1](true);
                                    }
                                }
                                if (field.max != undefined) {
                                    if (num > field.max) {
                                        field.err[1](true);
                                    }
                                }
                            }
                        }
                        />
                    </td>
                )
            })
            }
        </tr>
    )
}