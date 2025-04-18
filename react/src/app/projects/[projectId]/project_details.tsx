import { HtmlPage } from "@/app/components/html_page";
import { JsonErrorMsg } from "@/app/utils/fetching";
import { createGlobMatchRegex } from "@/app/utils/glob_matcher";
import { createLink } from "@/app/utils/path_utils";
import { Alert, AnchorButton, Button, ButtonGroup, Colors, Divider, HTMLSelect, Icon, InputGroup, NonIdealState, NumericInput } from "@blueprintjs/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import React, { Dispatch, ReactNode, SetStateAction, useEffect, useMemo, useState } from "react";
import { DeviceState, MASTER_PROJECT_NAME, ProjectDeviceDetails, ProjectDeviceDetailsNumericKeys, ProjectFFT, ProjectInfo, addFftsToProject, fetchKeymap, fetchProjectFfts, fetchProjectInfo, isProjectInDevelopment, isUserAProjectApprover, isUserAProjectEditor, removeFftsFromProject, whoAmI } from "../project_model";
import { ProjectExportDialog, ProjectImportDialog } from "../projects_overview_dialogs";
import { CopyFFTToProjectDialog, FFTCommentViewerDialog, FilterFFTDialog, ProjectEditConfirmDialog, ProjectHistoryDialog, SnapshotCreationDialog, SnapshotSelectionDialog } from "./project_dialogs";

import { LoadingSpinner } from "@/app/components/loading";
import { AddFftDialog } from "@/app/ffts/ffts_overview";
import { mapLen } from "@/app/utils/data_structure_utils";
import { numberOrDefault } from "@/app/utils/num_utils";
import { SortState, sortNumber, sortString } from "@/app/utils/sort_utils";
import { FFTInfo } from "../project_model";
import styles from './project_details.module.css';

type deviceDetailsColumn = (keyof Omit<ProjectDeviceDetails, "id" | "comments" | "discussion">);

/**
 * Helper function for sorting device details based on the clicked table column header
 */
export function sortDeviceDataByColumn(data: ProjectDeviceDetails[], col: deviceDetailsColumn, desc: boolean) {
    if (data.length == 0) {
        return; // nothing to sort
    }

    switch (col) {
        case "fc":
            data.sort((a, b) => {
                let diff = sortString(a.fc, b.fc, desc);
                if (diff != 0) {
                    return diff;
                }
                return sortString(a.fg_desc, b.fg_desc, false); // asc 
            });
            break;
        case "fg":
            data.sort((a, b) => {
                let diff = sortString(a.fg_desc, b.fg_desc, desc);
                if (diff != 0) {
                    return diff;
                }
                return sortString(a.fc, b.fc, false); // asc
            });
            break;
        default:
            let isNumericField = ProjectDeviceDetailsNumericKeys.indexOf(col) >= 0;
            if (isNumericField) {
                data.sort((a, b) => {
                    let diff = sortNumber(a[col] as any, b[col] as any, desc);
                    if (diff != 0) {
                        return diff;
                    }
                    return sortString(a.fc, b.fc, false); // asc
                })
            } else {
                data.sort((a, b) => {
                    let diff = sortString(a[col] as any ?? '', b[col] as any ?? '', desc);
                    if (diff != 0) {
                        return diff
                    }
                    return sortString(a.fc, b.fc, false); // asc
                });
            }

            break;
    }
}


// a project specific page displays all properties of a specific project 
export const ProjectDetails: React.FC<{ projectId: string }> = ({ projectId }) => {
    // page and url info
    const router = useRouter();
    const pathName = usePathname();
    const queryParams = useSearchParams();

    // data and loading
    const [isLoading, setIsLoading] = useState(true);
    const [fftDataLoadingError, setFftDataLoadingError] = useState('');
    const [project, setProject] = useState<ProjectInfo>();
    const [fftData, setFftData] = useState<ProjectDeviceDetails[]>([]);
    const [fftDataDisplay, setFftDataDisplay] = useState<ProjectDeviceDetails[]>([]);
    const [currentlyLoggedInUser, setCurrentlyLoggedInUser] = useState<string>('');
    const [keymap, setKeymap] = useState<Record<string, string>>({});
    /* @FUTURE: these two fields may come from backend in the future */
    const [deviceLocations, setDeviceLocations] = useState(["", "EBD", "FEE", "H1.1", "H1.2", "H1.3", "H2", "XRT", "Alcove", "H4", "H4.5", "H5", "H6"]);
    const [beamlineLocations, setBeamlineLocations] = useState(["", "TMO", "RIX", "TXI-SXR", "TXI-HXR", "XPP", "DXS", "MFX", "CXI", "MEC"]);

    // dialogs open state
    const [isAddNewFftDialogOpen, setIsAddNewFftDialogOpen] = useState(false);
    const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);
    const [isCopyFFTDialogOpen, setIsCopyFFTDialogOpen] = useState(false);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
    const [isProjectHistoryDialogOpen, setIsProjectHistoryDialogOpen] = useState(false);
    const [isTagSelectionDialogOpen, setIsTagSelectionDialogOpen] = useState(false);
    const [isTagCreationDialogOpen, setIsTagCreationDialogOpen] = useState(false);
    const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
    const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);

    const [isFftCommentViewerOpen, setIsFftCommentViewerOpen] = useState(false);
    const [commentDevice, setCommentDevice] = useState<ProjectDeviceDetails>();

    const [currentFFT, setCurrentFFT] = useState<ProjectFFT>({ _id: "", fc: "", fg: "" });
    const [errorAlertMsg, setErrorAlertMsg] = useState<ReactNode>('');

    // filters to apply
    const [fcFilter, setFcFilter] = useState("");
    const [fgFilter, setFgFilter] = useState("");
    const [availableFftStates, setAvailableFftStates] = useState<DeviceState[]>(DeviceState.allStates);
    const [stateFilter, setStateFilter] = useState("");
    const [showFftSinceCreationFilter, setShowFftSinceCreationFilter] = useState(false);
    const [asOfTimestampFilter, setAsOfTimestampFilter] = useState("");

    // tag creation
    const [tagName, setTagName] = useState("");

    // state suitable for row updates
    const [editedDevice, setEditedDevice] = useState<ProjectDeviceDetails>();

    const [sortedByColumn, setSortedByColumn] = useState<SortState<deviceDetailsColumn>>(new SortState('fc', false));


    const changeSortOrder = (columnClicked: deviceDetailsColumn) => {
        let newSortOrder = sortedByColumn.changed(columnClicked);
        setSortedByColumn(newSortOrder);
    }

    const loadFFTData = (projectId: string, showAllEntries: boolean = true, sinceTime?: Date): Promise<void | ProjectDeviceDetails[]> => {
        setIsLoading(true);
        setFftDataLoadingError('');
        return fetchProjectFfts(projectId, showAllEntries, sinceTime)
            .then(devices => {
                setFftData(devices);
                return devices;
            }).catch((e: JsonErrorMsg) => {
                let msg = `Failed to load device data: ${e.error}`;
                setFftData([]);
                setFftDataLoadingError(msg);
                console.error(msg, e);
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
            setFgFilter(queryParams.get("fg_desc") ?? "");
            setStateFilter(queryParams.get("state") ?? "");
            setAsOfTimestampFilter(queryParams.get("asoftimestamp") ?? "");
        }

        const showAllEntries = true;
        const timestampFilter = queryParams.get("asoftimestamp") ?? '';
        const asOfTimestamp = timestampFilter ? new Date(timestampFilter) : undefined;

        const loadInitialData = async () => {
            const [data, fftData, keymapData, whoami] = await Promise.all([
                fetchProjectInfo(projectId),
                fetchProjectFfts(projectId, showAllEntries, asOfTimestamp),
                fetchKeymap(),
                whoAmI(),
            ])
            return { data, fftData, keymapData, whoami };
        }

        loadInitialData().then(d => {
            setProject(d.data);
            setFftData(d.fftData);
            setKeymap(d.keymapData);
            setCurrentlyLoggedInUser(d.whoami);
        }).catch((e: JsonErrorMsg) => {
            console.error("Failed to load required project data", e);
            setErrorAlertMsg("Failed to load project info: most actions will be disabled.\nError: " + e.error);
        }).finally(() => {
            setIsLoading(false);
        })
    }, []);


    // apply table filters, when any filter or original data changes
    useEffect(() => {
        let fcGlobMatcher = createGlobMatchRegex(fcFilter)
        let fgGlobMatcher = createGlobMatchRegex(fgFilter);
        let filteredFftData = fftData.filter(d => {
            if (fcFilter) {
                return fcGlobMatcher.test(d.fc);
            }
            return true;
        }).filter(d => {
            if (fgFilter) {
                return fgGlobMatcher.test(d.fg_desc);
            }
            return true;
        }).filter(d => {
            if (stateFilter) {
                return d.state === stateFilter;
            }
            return true;
        })

        sortDeviceDataByColumn(filteredFftData, sortedByColumn.column, sortedByColumn.sortDesc);
        setFftDataDisplay(filteredFftData);
    }, [fftData, fcFilter, fgFilter, stateFilter, sortedByColumn]);


    const displayFilterIconInColumn = (filterValue: string) => {
        if (!filterValue) {
            return null;
        }
        return <Icon icon="filter" color={Colors.RED2} className="ms-1" />
    }

    const displaySortOrderIconInColumn = (col: deviceDetailsColumn) => {
        if (col != sortedByColumn.column) {
            return null;
        }
        return <Icon icon={sortedByColumn.sortDesc ? "arrow-down" : "arrow-up"} className="ms-1" />
    }

    const updateQueryParams = (fcFilter: string, fgFilter: string, stateFilter: string, asOfTimestampFilter: string) => {
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
        if (asOfTimestampFilter) {
            params.set("asoftimestamp", asOfTimestampFilter)
        }
        router.replace(`${pathName}?${params.toString()}`)
    }

    const addNewFft = (newFft: FFTInfo) => {
        if (!project) {
            // this should never happen
            setErrorAlertMsg("Can't add a new fft to a project without knowing the projec details; this is a programming bug");
            return;
        }

        // check if desired fft combination already exist within the project 
        // if it does, simply show an error message to the user
        for (let fft of fftData) {
            if (fft.fc === newFft.fc.name && fft.fg === newFft.fg.name) {
                setErrorAlertMsg(<>FC <b>{fft.fc}</b> is already a part of the project: "{project.name}".</>);
                return
            }
        }

        let fft: ProjectFFT = {
            _id: newFft._id,
            fc: newFft.fc._id,
            fg: newFft.fg._id,
        }
        return addFftsToProject(project._id, [fft])
            .then(data => {
                // TODO: when we try to add an fft that is already there, the backend doesn't complain
                // it just returns success: true, erromsg: no changes detected.
                // TODO: we only need the fft that was updated, not all ffts of the project
                setFftData(data)
                setIsAddNewFftDialogOpen(false);
            }).catch((e: JsonErrorMsg) => {
                let msg = "Failed to add an fft to a project: " + e.error;
                console.error(msg, e);
                setErrorAlertMsg(msg);
            });
    }

    const createCsvStringFromDevices = (devices: ProjectDeviceDetails[]): string => {
        // render field or empty if it's undefined
        const r = (field: any) => {
            if (field == undefined || field == null) {
                return '';
            }
            return field;
        }

        // create the csv document from filtered devices
        let data = `FC,Fungible,TC_part_no,Stand,State,LCLS_Z_loc,LCLS_X_loc,LCLS_Y_loc,LCLS_Z_roll,LCLS_X_pitch,LCLS_Y_yaw,Must_Ray_Trace,Comments\n`;
        for (let device of devices) {
            data += `${r(device.fc)},${r(device.fg_desc)},${r(device.tc_part_no)},${r(device.stand)},${r(device.state)},${r(device.nom_loc_z)},${r(device.nom_loc_x)},${r(device.nom_loc_y)},${r(device.nom_ang_z)},${r(device.nom_ang_x)},${r(device.nom_ang_y)},${r(device.ray_trace)},${r(device.comments)}\n`;
        }
        return data;
    }

    const isProjectApproved = project && project.name == MASTER_PROJECT_NAME;
    const isProjectInDevelopment = project && project.name !== MASTER_PROJECT_NAME && project.status === "development";
    const isFilterApplied = fcFilter != "" || fgFilter != "" || stateFilter != "";
    const isRemoveFilterEnabled = isFilterApplied || showFftSinceCreationFilter || asOfTimestampFilter;
    const isEditedTable = editedDevice != undefined;
    const disableActionButtons = !project || project.name === MASTER_PROJECT_NAME || project.status != "development" || !isUserAProjectEditor(project, currentlyLoggedInUser)

    if (isLoading) {
        return (
            <HtmlPage>
                <LoadingSpinner className="mb-4 mt-4" title="Loading" description={"Loading project data..."} isLoading={isLoading} />
            </HtmlPage>
        )
    }

    if (fftDataLoadingError) {
        return (
            <HtmlPage>
                <NonIdealState className="mb-4 mt-4" icon="error" title="Error" description={fftDataLoadingError} />
            </HtmlPage>
        )
    }

    return (
        <HtmlPage>
            {/* NOTE: horizontally scrollable table with sticky header only works if it's max height is capped */}
            <div className="table-responsive" style={{ maxHeight: 'calc(100vh - 130px)' }}>
                <table className={`table table-bordered table-sm table-sticky table-striped ${styles.detailsTable} ${isProjectInDevelopment ? "dev" : ""}`}>
                    <thead>
                        <tr>
                            <th colSpan={isProjectInDevelopment ? 8 : 7}>
                                {!project ? <></> :
                                    <ButtonGroup vertical={false} className={isEditedTable ? "table-disabled" : ''}>

                                        <h5 className="m-0 me-3" style={{ color: Colors.RED2 }}>{project?.name}</h5>

                                        <Button icon="import" title="Download a copy of this project"
                                            minimal={true} small={true}
                                            onClick={(e) => { setIsExportDialogOpen(true) }}
                                        />

                                        <Button icon="bring-data" title="Download filtered data"
                                            minimal={true} small={true}
                                            disabled={!isFilterApplied}
                                            onClick={e => {
                                                let data = createCsvStringFromDevices(fftDataDisplay)
                                                let blob = new Blob([data], { type: "text/plain" });
                                                let url = window.URL.createObjectURL(blob);
                                                let a = document.createElement('a');
                                                a.href = url;
                                                const now = new Date().toISOString();
                                                a.download = `${project.name}_${now}_filtered.csv`;
                                                a.click();
                                            }}
                                        />

                                        <Button icon="export" title="Upload data to this project"
                                            minimal={true} small={true}
                                            disabled={disableActionButtons}
                                            onClick={(e) => { setIsImportDialogOpen(true) }}
                                        />

                                        <Divider />

                                        <Button icon="add" title="Add a new Device to Project" minimal={true} small={true}
                                            disabled={disableActionButtons}
                                            onClick={e => setIsAddNewFftDialogOpen(true)}
                                        />

                                        <Divider />

                                        <Button icon="filter" title="Filter FFTs" minimal={true} small={true} intent={isFilterApplied ? "warning" : "none"} onClick={(e) => setIsFilterDialogOpen(true)} />

                                        <Button icon="filter-remove" title="Clear filters to show all FFTs" minimal={true} small={true} disabled={!isRemoveFilterEnabled}
                                            onClick={(e) => {
                                                setFcFilter('')
                                                setFgFilter('');
                                                setStateFilter('');
                                                let timestampFilter = asOfTimestampFilter;
                                                setAsOfTimestampFilter('');

                                                if (showFftSinceCreationFilter) {
                                                    setShowFftSinceCreationFilter(false);
                                                    loadFFTData(project._id, true);
                                                } else if (timestampFilter) {
                                                    // timestamp filter was applied and now we have to load original data
                                                    loadFFTData(project._id, true);
                                                }
                                                updateQueryParams('', '', '', '');
                                            }}
                                        />

                                        <Button icon="filter-open" minimal={true} small={true} intent={showFftSinceCreationFilter ? "warning" : "none"}
                                            title="Show only FCs with changes after the project was created"
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
                                        />

                                        <Divider />
                                        {isProjectApproved ?
                                            <>
                                                <Button icon="tag-add" title="Create a snapshot" minimal={true} small={true}
                                                    onClick={(e) => { setIsTagCreationDialogOpen(true) }}
                                                />
                                                <Button icon="tags" title="Show created snapshots" minimal={true} small={true}
                                                    onClick={(e) => { setIsTagSelectionDialogOpen(true) }}
                                                />
                                                <Divider />
                                            </>
                                            : null
                                        }
                                        <Button icon="history" title="Show the history of changes" minimal={true} small={true}
                                            intent={asOfTimestampFilter ? "danger" : "none"}
                                            onClick={(e) => setIsProjectHistoryDialogOpen(true)}
                                        />
                                        <AnchorButton icon="user" title="Submit this project for approval" minimal={true} small={true}
                                            href={createLink(`/projects/${project._id}/submit-for-approval`)}
                                            disabled={disableActionButtons}
                                        />

                                        {isUserAProjectApprover(project, currentlyLoggedInUser) || (isUserAProjectEditor(project, currentlyLoggedInUser) && project.status == "submitted") ?
                                            <>
                                                <Divider />
                                                <AnchorButton icon="confirm" title="Approve submitted project" intent="danger" minimal={true} small={true}
                                                    href={createLink(`/projects/${project._id}/approval`)}
                                                />
                                            </>
                                            : null
                                        }

                                    </ButtonGroup>
                                }
                            </th>

                            <th colSpan={3} className="text-center">Nominal Location (meters in LCLS coordinates)</th>
                            <th colSpan={3} className="text-center">Nominal Angle (radians)</th>
                            <th></th>
                            <th></th>
                        </tr>
                        <tr>
                            {isProjectInDevelopment ? <th></th> : null}
                            <th onClick={e => changeSortOrder('fc')}>FC {displayFilterIconInColumn(fcFilter)}{displaySortOrderIconInColumn('fc')}</th>
                            <th onClick={e => changeSortOrder('fg_desc')}>Fungible {displayFilterIconInColumn(fgFilter)}{displaySortOrderIconInColumn('fg_desc')}</th>
                            <th onClick={e => changeSortOrder('tc_part_no')}>TC Part No. {displaySortOrderIconInColumn('tc_part_no')}</th>
                            <th onClick={e => changeSortOrder('stand')}>Stand/Nearest Stand {displaySortOrderIconInColumn('stand')}</th>
                            <th onClick={e => changeSortOrder('location')}>Location {displaySortOrderIconInColumn('location')}</th>
                            <th onClick={e => changeSortOrder('beamline')}>Beamline {displaySortOrderIconInColumn('beamline')}</th>
                            <th onClick={e => changeSortOrder('state')}>State {displayFilterIconInColumn(stateFilter)} {displaySortOrderIconInColumn('state')}</th>

                            <th onClick={e => changeSortOrder('nom_loc_z')} className="text-center">Z {displaySortOrderIconInColumn('nom_loc_z')}</th>
                            <th onClick={e => changeSortOrder('nom_loc_x')} className="text-center">X {displaySortOrderIconInColumn('nom_loc_x')}</th>
                            <th onClick={e => changeSortOrder('nom_loc_y')} className="text-center">Y {displaySortOrderIconInColumn('nom_loc_y')}</th>

                            <th onClick={e => changeSortOrder('nom_ang_z')} className="text-center">Rz {displaySortOrderIconInColumn('nom_ang_z')}</th>
                            <th onClick={e => changeSortOrder('nom_ang_x')} className="text-center">Rx {displaySortOrderIconInColumn('nom_ang_x')}</th>
                            <th onClick={e => changeSortOrder('nom_ang_y')} className="text-center">Ry {displaySortOrderIconInColumn('nom_ang_y')}</th>
                            <th onClick={e => changeSortOrder('ray_trace')}>Must Ray Trace {displaySortOrderIconInColumn('ray_trace')}</th>

                            <th>Comments</th>
                        </tr>
                    </thead>
                    <tbody>
                        {fftDataDisplay.map(device => {
                            const isEditedDevice = editedDevice == device;
                            const disableRow = isEditedTable && !isEditedDevice;
                            if (!isEditedDevice) {
                                return <DeviceDataTableRow key={device.id}
                                    project={project} device={device} currentUser={currentlyLoggedInUser}
                                    disabled={disableRow}
                                    onEdit={(device) => setEditedDevice(device)}
                                    onCopyFft={(device) => {
                                        setCurrentFFT({ _id: device.id, fc: device.fc, fg: device.fg });
                                        setIsCopyFFTDialogOpen(true);
                                    }}
                                    onDeleteFft={(device) => {
                                        setCurrentFFT({ _id: device.id, fc: device.fc, fg: device.fg });
                                        setIsDeleteDialogOpen(true);
                                    }}
                                    onUserComment={(device) => {
                                        setCommentDevice(device);
                                        setIsFftCommentViewerOpen(true);
                                    }}
                                />
                            }

                            return <DeviceDataEditTableRow key={device.id} keymap={keymap} project={project} device={device}
                                availableFftStates={availableFftStates}
                                availableLocations={deviceLocations}
                                availableBeamlines={beamlineLocations}
                                onEditDone={(updatedDeviceData, action) => {
                                    if (action == "cancel") {
                                        setEditedDevice(undefined);
                                        return;
                                    }

                                    // replace the change device with new/updated data
                                    // if the user replaced 'fc' or 'fg' of the device, the new device
                                    // will have a different id.
                                    const oldDevice = device;
                                    let updatedDevices = [...fftData];
                                    for (let i = 0; i < updatedDevices.length; i++) {
                                        const device = updatedDevices[i];
                                        if (device.id === oldDevice.id) {
                                            // found the device index that has to be replaced
                                            updatedDevices[i] = updatedDeviceData;
                                            break;
                                        }
                                    }

                                    setFftData(updatedDevices);
                                    setEditedDevice(undefined);
                                }}
                            />
                        })
                        }
                    </tbody>
                </table>
            </div>

            {!isLoading && !fftDataLoadingError && !isFilterApplied && fftDataDisplay.length == 0 ?
                <NonIdealState icon="search" title="No FCs Found" description={<>Project {project?.name} does not have any FCs</>} />
                : null}

            {!isLoading && isFilterApplied && fftDataDisplay.length == 0 ?
                <NonIdealState icon="filter" title="No FCs Found" description="Try changing your filters"></NonIdealState>
                : null
            }

            {project ?
                <AddFftDialog
                    dialogType="addToProject"
                    isOpen={isAddNewFftDialogOpen}
                    onClose={() => setIsAddNewFftDialogOpen(false)}
                    onSubmit={(newFft) => addNewFft(newFft)}
                />
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
                    updateQueryParams(newFcFilter, newFgFilter, newStateFilter, asOfTimestampFilter);
                    setIsFilterDialogOpen(false);
                }}
            />

            {project ?
                <CopyFFTToProjectDialog
                    isOpen={isCopyFFTDialogOpen}
                    FFT={currentFFT}
                    currentProject={project}
                    onClose={() => setIsCopyFFTDialogOpen(false)}
                    onSubmit={(newDeviceDetails) => {
                        // find current fft and update device details
                        let updatedData = [];
                        for (let d of fftData) {
                            if (d.id != newDeviceDetails.id) {
                                updatedData.push(d);
                                continue;
                            }
                            updatedData.push(newDeviceDetails);
                        }
                        setFftData(updatedData);
                        setIsCopyFFTDialogOpen(false);
                    }}
                /> : null}

            {project ?
                <Alert className="alert-default"
                    intent="danger"
                    cancelButtonText="Cancel"
                    confirmButtonText="Delete"
                    isOpen={isDeleteDialogOpen}
                    onClose={e => {
                        setCurrentFFT({ _id: '', fc: '', fg: '' });
                        setIsDeleteDialogOpen(false);
                    }}
                    onConfirm={(e) => {
                        const fft = currentFFT
                        removeFftsFromProject(project._id, [fft])
                            .then(() => {
                                setCurrentFFT({ _id: '', fc: '', fg: '' });
                                setIsDeleteDialogOpen(false);

                                // update data 
                                let updatedFftData = fftData.filter(d => d.id != fft._id);
                                setFftData(updatedFftData);
                            }).catch((e: JsonErrorMsg) => {
                                let msg = `Failed to delete a device ${currentFFT.fc}-${currentFFT.fg}: ${e.error}`;
                                setErrorAlertMsg(msg);
                            });
                    }}
                >
                    <h5 className="alert-title"><Icon icon="trash" />Delete {currentFFT.fc}?</h5>
                    <p>Do you really want to delete a device <b>{currentFFT.fc}</b> from a project <b>{project.name}</b>?</p>
                    <p><i>This will permanently delete the entire history of device value changes, as well as all related discussion comments!</i></p>
                </Alert>
                : null
            }

            {project && commentDevice ?
                <FFTCommentViewerDialog
                    isOpen={isFftCommentViewerOpen}
                    project={project}
                    user={currentlyLoggedInUser}
                    device={commentDevice}
                    onClose={() => {
                        setCommentDevice(undefined);
                        setIsFftCommentViewerOpen(false);
                    }}
                    onCommentAdd={(updatedDevice) => {
                        // TODO: this is repeated multiple times, extract into method at some point
                        let updatedFftData = [];
                        for (let fft of fftData) {
                            if (fft.id != updatedDevice.id) {
                                updatedFftData.push(fft);
                                continue;
                            }
                            updatedFftData.push(updatedDevice);
                        }
                        setFftData(updatedFftData);
                        setCommentDevice(updatedDevice);
                    }
                    }
                />
                : null}

            {project ?
                <ProjectHistoryDialog
                    currentProject={project}
                    keymap={keymap}
                    isOpen={isProjectHistoryDialogOpen}
                    onClose={() => setIsProjectHistoryDialogOpen(false)}
                    displayProjectSince={(time) => {
                        loadFFTData(project._id, true, time);
                        setIsProjectHistoryDialogOpen(false);

                        let timestampFilter = time.toISOString();
                        updateQueryParams(fcFilter, fgFilter, stateFilter, timestampFilter);
                        setAsOfTimestampFilter(timestampFilter);
                    }}
                />
                : null}
            {project && isProjectApproved ?
                <SnapshotSelectionDialog
                    isOpen={isTagSelectionDialogOpen}
                    projectId={project._id}
                    onSubmit={(tagDate) => {
                        loadFFTData(project._id, true, tagDate);
                        updateQueryParams(fcFilter, fgFilter, stateFilter, tagDate.toISOString());
                        setAsOfTimestampFilter(tagDate.toISOString());
                        setIsTagSelectionDialogOpen(false);
                    }}
                    onClose={() => setIsTagSelectionDialogOpen(false)}
                />
                : null}
            {project && isProjectApproved ?
                <SnapshotCreationDialog
                    isOpen={isTagCreationDialogOpen}
                    projectId={project._id}
                    onSubmit={() => setIsTagCreationDialogOpen(false)}
                    onClose={() => setIsTagCreationDialogOpen(false)}
                />
                : null}
            {project ?
                <ProjectImportDialog
                    isOpen={isImportDialogOpen}
                    project={project}
                    onClose={(dataImported) => {
                        if (dataImported) {
                            // clear filters and reload devices so that the user can see the imported devices right away 
                            setFcFilter('')
                            setFgFilter('');
                            setStateFilter('');
                            setAsOfTimestampFilter('');
                            setShowFftSinceCreationFilter(false);
                            updateQueryParams('', '', '', '');
                            const showAllEntries = true;
                            loadFFTData(projectId, showAllEntries);
                        }
                        setIsImportDialogOpen(false);
                    }}
                />
                : null}
            {project ?
                <ProjectExportDialog
                    isOpen={isExportDialogOpen}
                    project={project}
                    onSubmit={() => setIsExportDialogOpen(false)}
                    onClose={() => setIsExportDialogOpen(false)}
                />
                : null
            }
            {/* Alert for displaying error messages that may happen in other dialogs */}
            <Alert
                className="alert-default"
                confirmButtonText="Ok"
                onConfirm={(e) => setErrorAlertMsg('')}
                intent="danger"
                isOpen={errorAlertMsg != ""}>
                <h5 className="alert-title"><Icon icon="error" />Error</h5>
                <p>{errorAlertMsg}</p>
            </Alert>
        </HtmlPage >
    )
}

export const formatDevicePositionNumber = (value?: number | string): string => {
    if (value === undefined) {
        return '';
    }
    if (typeof value === "string") {
        return value;
    }
    return value.toFixed(7);
}


const DeviceDataTableRow: React.FC<{ project?: ProjectInfo, device: ProjectDeviceDetails, currentUser: string, disabled: boolean, onEdit: (device: ProjectDeviceDetails) => void, onCopyFft: (device: ProjectDeviceDetails) => void, onDeleteFft: (device: ProjectDeviceDetails) => void, onUserComment: (device: ProjectDeviceDetails) => void }> = ({ project, device, currentUser, disabled, onEdit, onCopyFft, onDeleteFft, onUserComment }) => {
    // we have to cache each table row, as once we have lots of rows in a table editing text fields within
    // becomes very slow due to constant rerendering of rows and their tooltips on every keystroke. 
    const row = useMemo(() => {
        return (
            <tr className={disabled ? 'table-disabled' : ''}>
                {project && isProjectInDevelopment(project) ?
                    <td>
                        {isUserAProjectEditor(project, currentUser) ?
                            <>
                                <Button icon="edit" minimal={true} small={true} title="Edit this device"
                                    onClick={(e) => onEdit(device)}
                                />
                                <Button icon="refresh" minimal={true} small={true} title={"Copy over the value from another project"}
                                    onClick={(e) => onCopyFft(device)}
                                />
                                <Button icon="trash" minimal={true} small={true} title={"Delete this device"}
                                    onClick={(e) => onDeleteFft(device)}
                                />
                            </>
                            : null
                        }

                        <Button icon="chat" minimal={true} small={true} title={"See user comments"}
                            onClick={(e) => onUserComment(device)}
                        >({device.discussion.length})</Button>
                    </td>
                    : null
                }

                <td>{device.fc}</td>
                <td>{device.fg_desc}</td>
                <td>{device.tc_part_no}</td>
                <td>{device.stand}</td>
                <td>{device.location}</td>
                <td>{device.beamline}</td>
                <td>{device.state}</td>

                <td className="text-number">{formatDevicePositionNumber(device.nom_loc_z)}</td>
                <td className="text-number">{formatDevicePositionNumber(device.nom_loc_x)}</td>
                <td className="text-number">{formatDevicePositionNumber(device.nom_loc_y)}</td>

                <td className="text-number">{formatDevicePositionNumber(device.nom_ang_z)}</td>
                <td className="text-number">{formatDevicePositionNumber(device.nom_ang_x)}</td>
                <td className="text-number">{formatDevicePositionNumber(device.nom_ang_y)}</td>

                <td>{device.ray_trace ?? null}</td>

                <td>{device.comments}</td>
            </tr>
        )
    }, [project, device, currentUser, disabled])
    return row;
}



const DeviceDataEditTableRow: React.FC<{
    project?: ProjectInfo,
    keymap: Record<string, string>,
    device: ProjectDeviceDetails,
    availableFftStates: DeviceState[],
    availableLocations: string[],
    availableBeamlines: string[],
    onEditDone: (newDevice: ProjectDeviceDetails, action: "ok" | "cancel") => void,
}> = ({ project, keymap, device, availableFftStates, availableLocations, availableBeamlines, onEditDone }) => {
    const [editError, setEditError] = useState('');
    const [isSubmitting, setSubmitting] = useState(false);
    const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
    const [valueChanges, setValueChanges] = useState<Record<string, any>>({});

    interface EditField {
        key: (keyof ProjectDeviceDetails);
        type: "string" | "number" | "select"
        value: [string | undefined, Dispatch<SetStateAction<string | undefined>>];
        valueOptions?: string[]; // only used when type == "select"
        err: [boolean, Dispatch<SetStateAction<boolean>>];
        min?: number;
        max?: number;
        allowNumbersOnly?: boolean;
    }

    let fftStates = useMemo(() => {
        return availableFftStates.map(s => s.name);
    }, [availableFftStates])

    const editableDeviceFields: EditField[] = [
        { key: 'fc', type: "string", value: useState<string>(), err: useState(false) },
        { key: 'fg_desc', type: "string", value: useState<string>(), err: useState(false) },
        { key: 'tc_part_no', type: "string", value: useState<string>(), err: useState(false) },
        { key: 'stand', type: "string", value: useState<string>(), err: useState(false) },
        { key: 'location', type: "select", valueOptions: availableLocations, value: useState<string>(), err: useState(false) },
        { key: 'beamline', type: "select", valueOptions: availableBeamlines, value: useState<string>(), err: useState(false) },
        { key: 'state', type: "select", valueOptions: fftStates, value: useState<string>(), err: useState(false) },

        { key: 'nom_loc_z', type: "number", value: useState<string>(), err: useState(false) },
        { key: 'nom_loc_x', type: "number", value: useState<string>(), err: useState(false) },
        { key: 'nom_loc_y', type: "number", value: useState<string>(), err: useState(false) },

        { key: 'nom_ang_z', type: "number", value: useState<string>(), err: useState(false) },
        { key: 'nom_ang_x', type: "number", value: useState<string>(), err: useState(false) },
        { key: 'nom_ang_y', type: "number", value: useState<string>(), err: useState(false) },

        { key: 'ray_trace', type: "number", value: useState<string>(), err: useState(false), max: 1, min: 0, allowNumbersOnly: true },

        { key: 'comments', type: "string", value: useState<string>(), err: useState(false) },
    ]

    useEffect(() => {
        for (let field of editableDeviceFields) {
            if (field.key == 'id') { // fft field is not editable
                continue;
            }
            field.value[1](device[field.key] as any);
        }
    }, [device])

    let errStates = editableDeviceFields.map(f => f.err[0]);
    const allFieldsAreValid = useMemo(() => {
        for (let f of editableDeviceFields) {
            if (f.err[0] === true) {
                return false;
            }
        }

        // all fields are valid, we can submit this change
        return true;
    }, [...errStates])


    const createDeviceWithChanges = (device: ProjectDeviceDetails, fields: EditField[]): ProjectDeviceDetails => {
        let copyDevice = structuredClone(device);
        for (let editField of fields) {
            let field = editField.key;
            let device = copyDevice as any;
            if (editField.type == "number") {
                device[field] = numberOrDefault(editField.value[0], undefined);
            } else {
                device[field] = editField.value[0] || '';
            }
        }
        return copyDevice;
    }

    const getValueChanges = (device: Readonly<ProjectDeviceDetails>): Record<string, any> => {
        let deviceWithChanges = createDeviceWithChanges(device, editableDeviceFields);

        // find changes that have to be synced with backend
        // later on, we may have to add a user comment to each of those changes
        let fieldNames = Object.keys(deviceWithChanges) as (keyof ProjectDeviceDetails)[];
        fieldNames = fieldNames.filter(field => field != "id" && field != "discussion");
        let changes: Record<string, any> = {};
        for (let field of fieldNames) {
            let value = deviceWithChanges[field];
            if (typeof value === "string") {
                value = value.trim();
            }

            const currentValue = device[field]
            if (value !== currentValue) { // this field has changed
                if (currentValue === undefined && value === '') {
                    // this field has not changed (the current device value is not set and 'new' value is not set [empty])
                    continue;
                }

                // field has changed
                if (field === "state") {
                    // we have to transform the state from what's displayed into an enum that
                    // a backend understands, hence this transformation
                    changes[field] = DeviceState.fromString(deviceWithChanges[field]).backendEnumName;
                    continue;
                }
                changes[field] = value;
            }
        }
        return { deviceWithChanges, changes };
    }

    const submitChanges = () => {
        const { changes, deviceWithChanges } = getValueChanges(device);
        if (mapLen(changes) === 0) { // nothing to sync
            onEditDone(deviceWithChanges, 'cancel');
            return;
        }

        if (!project) {
            // this should never happen
            let msg = "Project that we want to sync our changes to does not exist: this is a programming bug that should never happen";
            console.error(msg);
            setEditError(msg)
            return;
        }

        setValueChanges(changes);
        setConfirmDialogOpen(true);
    }

    return (
        <tr>
            <td>
                <Button icon="tick" minimal={true} small={true} loading={isSubmitting}
                    title="Submit your edits"
                    disabled={!allFieldsAreValid}
                    onClick={(e) => submitChanges()}
                />

                <Button icon="cross" minimal={true} small={true} title="Discard your edits"
                    onClick={(e) => onEditDone(createDeviceWithChanges(device, editableDeviceFields), "cancel")}
                />
            </td>

            {editableDeviceFields.map((field) => {
                // the reason why we use components instead of rendering edit fields directly is due to performance
                // Rerendering the entire row and all its fields on every keystroke is noticably slow, therefore
                // we cache edit fields via components.
                let inputField: ReactNode;
                if (field.type == "string") {
                    inputField = <StringEditField value={field.value[0] ?? ''} setter={field.value[1]} err={field.err[0]} errSetter={field.err[1]} />
                } else if (field.type == "number") {
                    inputField = <NumericEditField value={field.value[0]} setter={field.value[1]} min={field.min} max={field.max} err={field.err[0]} errSetter={field.err[1]} allowNumbersOnly={field.allowNumbersOnly} />
                } else if (field.type == "select") {
                    inputField = <SelectEditField value={field.value[0] ?? ''} setter={field.value[1]} options={field.valueOptions || []} err={field.err[0]} errSetter={field.err[1]} />
                } else {
                    throw new Error("Unhandled field type: ", field.type)
                }
                return <td key={field.key}>{inputField}</td>
            })
            }


            {project && confirmDialogOpen ?
                <ProjectEditConfirmDialog
                    isOpen={confirmDialogOpen}
                    valueChanges={valueChanges}
                    keymap={keymap}
                    project={project}
                    device={device}
                    onClose={() => {
                        // we just close the dialog, the user has to click the 'x' icon in the edit row
                        // to cancel the editing process
                        setConfirmDialogOpen(false);
                    }}
                    onSubmit={(updatedDevice) => {
                        // the user confirmed the changes, and the device data was submitted 
                        // close the dialog and stop editing this row.
                        setConfirmDialogOpen(false);
                        onEditDone(updatedDevice, 'ok');
                    }}
                />
                : null
            }

            {editError ?
                <Alert
                    className="alert-default"
                    confirmButtonText="Ok"
                    onConfirm={(e) => setEditError('')}
                    intent="danger"
                    isOpen={editError != ""}>
                    <h5 className="alert-title"><Icon icon="error" />Error</h5>
                    <p>{editError}</p>
                </Alert>
                : null
            }
        </tr>
    )
}



const StringEditField: React.FC<{ value: string, setter: any, err: boolean, errSetter: any }> = ({ value, setter, err, errSetter }) => {
    return useMemo(() => {
        return <InputGroup value={value} onValueChange={(val) => setter(val)} style={{ width: 'auto', minWidth: "5ch" }} fill={true} />
    }, [value, err])
}

const SelectEditField: React.FC<{ value: string, setter: any, options: string[], err: boolean, errSetter: any }> = ({ value, setter, options, err, errSetter }) => {
    return useMemo(() => {
        return <HTMLSelect value={value} options={options} onChange={(e) => setter(e.target.value)} style={{ width: "auto" }} iconName="caret-down" fill={true} />
    }, [value, options, err])
}

// performance optimization to avoid re-rendering every field in a row every time the user types one character in one of them.
const NumericEditField: React.FC<{ value: string | number | undefined, setter: any, err: boolean, errSetter: any, min?: number, max?: number, allowNumbersOnly?: boolean }> = ({ value, setter, err, errSetter, min, max, allowNumbersOnly: allowNumericCharsOnly }) => {
    const isNumeric = (v: string) => {
        return /^\d+$/.test(v);
    }
    const field = useMemo(() => {
        return (<NumericInput
            buttonPosition="none"
            allowNumericCharactersOnly={false}
            intent={err ? "danger" : "none"}
            style={{ width: "auto", maxWidth: "15ch", textAlign: "right" }}
            value={value}
            stepSize={1}
            minorStepSize={0.0000000001} /* this is necessary to avoid warnings: numeric input rounds number based on this precision */
            majorStepSize={1}
            max={undefined}
            min={undefined}
            fill={true}
            onValueChange={(num, v) => {
                setter(v);
                if (isNaN(num)) {
                    errSetter(true);
                    return;
                }

                // we have a valid number
                errSetter(false);

                // check special behavior
                if (allowNumericCharsOnly && v != "") {
                    let numeric = isNumeric(v);
                    errSetter(!numeric);
                }

                // check ranges if any 
                if (min != undefined) {
                    if (num < min) {
                        errSetter(true);
                    }
                }
                if (max != undefined) {
                    if (num > max) {
                        errSetter(true);
                    }
                }
            }
            }
        />
        )
    }, [value, err])
    return field;
}