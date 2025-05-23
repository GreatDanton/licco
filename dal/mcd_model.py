"""
The model level business logic goes here.
Most of the code here gets a connection to the database, executes a query and formats the results.
"""
import logging
import datetime
import uuid
from collections.abc import Mapping
import math
from typing import Dict, Tuple, List, Optional
import pytz
from bson import ObjectId
from pymongo import ASCENDING, DESCENDING
from notifications.notifier import Notifier, NoOpNotifier
from . import mcd_validate
from .mcd_datatypes import MASTER_PROJECT_NAME, MongoDb, McdProject, FC_ATTRS, McdDevice
from .mcd_db import get_latest_project_data, get_all_project_changes, get_recent_snapshot, get_device
from .mcd_validate import common_component_fields
from .utils import ImportCounter, empty_string_or_none, diff_arrays

logger = logging.getLogger(__name__)

def initialize_collections(licco_db: MongoDb):
    if 'name_1' not in licco_db["projects"].index_information().keys():
        licco_db["projects"].create_index([("name", ASCENDING)], unique=True, name="name_1")
    # when listing all projects, we need to list projects for which the user is owner or editor (hence the index for both)
    if 'owner_1' not in licco_db["projects"].index_information().keys():
        licco_db["projects"].create_index([("owner", ASCENDING)], name="owner_1")
    if 'editors_1' not in licco_db["projects"].index_information().keys():
        licco_db["projects"].create_index([("editors", ASCENDING)], name="editors_1")

    if 'project_snapshots_1' not in licco_db["project_snapshots"].index_information().keys():
        licco_db["project_snapshots"].create_index([("project_id", ASCENDING), ("created", DESCENDING)], name="project_snapshots_1")

    if 'device_history_id_1' not in licco_db["device_history"].index_information().keys():
        licco_db["device_history"].create_index([("device_id", ASCENDING)], name="device_history_id_1")

    if 'app_1_name_1' not in licco_db["roles"].index_information().keys():
        licco_db["roles"].create_index([("app", ASCENDING), ("name", ASCENDING)], unique=True, name="app_1_name_1")

    # add a master project if it doesn't exist already
    master_project = licco_db["projects"].find_one({"name": MASTER_PROJECT_NAME})
    if not master_project:
        err, prj = create_new_project(licco_db, '', MASTER_PROJECT_NAME, "Master Project", [], NoOpNotifier())
        if err:
            logger.error(f"Failed to create a new master project: {err}")
        else:
            # initial status is set to approved
            licco_db["projects"].update_one({"_id": prj["_id"]}, {"$set": {"status": "approved"}})


def is_user_allowed_to_edit_project(db: MongoDb, userid: str, project: Dict[str, any]) -> bool:
    """
    Checks if a specific username is set as an owner or editor of a project,
    allowing them to edit the project
    """
    if userid == '' or None:
        return False

    allowed_to_edit = False
    allowed_to_edit |= userid == project.get('owner', None)
    allowed_to_edit |= userid in project.get('editors', [])
    if not allowed_to_edit:
        allowed_to_edit |= userid in get_users_with_privilege(db, "admin")
    return allowed_to_edit


def get_all_users(licco_db: MongoDb):
    """
    For now, simply return all the owners and editors of projects.
    """
    prjs = list(licco_db["projects"].find({}, {"owner": 1, "editors": 1}))
    ret = set()
    for prj in prjs:
        ret.add(prj["owner"])
        for ed in prj.get("editors", []):
            ret.add(ed)
    return list(ret)

def get_device_id_from_name(licco_db: MongoDb, prjid, fc):
    """
    Look up a device by its fc name and the project its affiliated with
    """
    device = licco_db["device_history"].find_one({"project_id": prjid, "fc": fc})
    if not device:
        return False, ""
    return True, str(device["_id"])

def get_users_with_privilege(licco_db: MongoDb, privilege):
    """
    From the roles database, get all the users with the necessary privilege. 
    For now we do not take into account group memberships. 
    We return a unique list of userid's, for example, [ "awallace", "klafortu", "mlng" ]
    """
    ret = set()
    # Super approvers and admins are a separate entry
    if privilege == "superapprover" or privilege == "admin":
        lookup = {"name": privilege} 
    else:
        lookup = {"privileges": privilege} 
    # looking for editors, owners, approvers, etc
    for role in licco_db["roles"].find(lookup):
        for player in role.get("players", []):
            if player.startswith("uid:"):
                ret.add(player.replace("uid:", ""))
    return sorted(list(ret))

def get_all_projects(licco_db: MongoDb, logged_in_user, sort_criteria = None):
    """
    Return all the projects in the system.
    :return: List of projects
    """
    filter = {}
    admins = get_users_with_privilege(licco_db, "admin")
    is_admin_user = logged_in_user in admins
    if is_admin_user:
        # admin users should see all projects, hence we don't specify the filter
        pass
    else:
        # regular user should only see the projects that are applicable (they are owner, editor or approver)
        # and which are visible (not hidden/deleted)
        filter = {"status": {"$ne": "hidden"},
                  "$and": [{
                      "$or": [
                          # master project should be always returned
                          {'name': MASTER_PROJECT_NAME},
                          {'owner': logged_in_user},
                          {'editors': logged_in_user},
                          {'approvers': logged_in_user},
                      ]
                  }]
                  }

    if not sort_criteria:
        # order in descending order
        sort_criteria = [["creation_time", -1]]

    all_projects = list(licco_db["projects"].find(filter).sort(sort_criteria))
    return all_projects


def get_projects_for_user(licco_db: MongoDb, username):
    """
    Return all the projects for which the user is an owner or an editor.
    :param username - the userid of the user from authn
    :return: List of projects
    """
    owned_projects = list(licco_db["projects"].find({"owner": username}))
    editable_projects = list(licco_db["projects"].find({"editors": username}))
    return owned_projects + editable_projects


def get_project(licco_db: MongoDb, id: str) -> Optional[McdProject]:
    """
    Get the details for the project given its id.
    """
    prj = licco_db["projects"].find_one({"_id": (ObjectId(id))})
    if prj:
        latest_edit = get_project_last_edit_time(licco_db, prj["_id"])
        if latest_edit:
            prj["edit_time"] = latest_edit
    return prj


def get_project_ffts(licco_db: MongoDb, prjid, showallentries=True, asoftimestamp=None, fftid=None):
    """
    Get the current devices with their data from a project id
    """
    return get_latest_project_data(licco_db, prjid, skipClonedEntries=False if showallentries else True, asoftimestamp=asoftimestamp, device_id=fftid)


def get_fcs(licco_db: MongoDb) -> List[str]:
    """
    Get the FC ids from a master project. These are generally used for autocompleting ids when the user creates
    a new device in a project.
    """
    master_project = get_master_project(licco_db)
    if not master_project:
        # we don't have any ffts
        return []

    # get device ffts
    ok, latest_master_project = get_recent_snapshot(licco_db, master_project["_id"])
    if not ok:
        return []

    ids = latest_master_project["devices"]
    fc_names = list(licco_db["device_history"].find({"_id": {"$in": ids}}, {"fc": 1, "_id": 0}))
    return [doc['fc'] for doc in fc_names]


def get_device_by_fc_name(licco_db: MongoDb, project_id: str, fc_name: str) -> Tuple[McdDevice, str]:
    ok, snapshot = get_recent_snapshot(licco_db, project_id)
    if not ok:
        return {}, f"Project {project_id} doesn't exist or it doesn't have any device data"
    # id should be in a snapshot and fc name should exist
    found_device = licco_db["device_history"].find_one({"_id": {"$in": snapshot["devices"]}, "fc": fc_name})
    if not found_device:
        return {}, f"Device {fc_name} was not found in a project {project_id}"

    return found_device, ""


def add_fft_comment(licco_db: MongoDb, user_id: str, project_id: str, device_id: str, comment: str):
    if not comment:
        return False, f"Comment should not be empty", None

    project = get_project(licco_db, project_id)
    project_name = project["name"]
    status = project["status"]

    allowed_to_comment = False
    allowed_to_comment |= user_id == project["owner"]
    allowed_to_comment |= user_id in project["editors"]

    if status == "submitted":
        allowed_to_comment |= user_id in project["approvers"]

    if not allowed_to_comment:
        allowed_to_comment |= user_id in get_users_with_privilege(licco_db, "admin")

    if not allowed_to_comment:
        return False, f"You are not allowed to comment on a device within a project '{project_name}'"

    new_comment = {
        'id': str(uuid.uuid4()),
        'author': user_id,
        'comment': comment,
        'time': datetime.datetime.now(datetime.UTC),
    }
    ok, snapshot = get_recent_snapshot(licco_db, project_id)
    if not ok:
        return ok, f"No snapshot found for project id {project_id}"

    if ObjectId(device_id) not in snapshot["devices"]:
        return False, f"No device with ID {device_id} exists in project {project_name}"

    status, errormsg = insert_comment_db(licco_db, project_id, device_id, new_comment)
    return status, errormsg


def insert_comment_db(licco_db: MongoDb, project_id: str, device_id: str, comment: Dict):
    try:
        licco_db["device_history"].update_one(
            {"_id": ObjectId(device_id)},
            {"$push": {"discussion": {'$each': [comment], '$position': 0}}})
    except Exception as e:
        return False, f"Unable to insert comment for device {device_id} in project {project_id}: {str(e)}"
    return True, ""


def delete_fft_comment(licco_db: MongoDb, user_id, project_id: str, device_id: str, comment_id):
    device = get_device(licco_db, device_id=device_id)
    if not device:
        return False, f"Device with id {device_id} does not exist"

    # check permissions for deletion
    project = get_project(licco_db, project_id)
    status = project["status"]
    project_is_in_correct_state = status == "development" or status == "submitted"
    if not project_is_in_correct_state:
        name = project["name"]
        return False, f"Comment {comment_id} could not be deleted: project '{name}' is not in a development or submitted state (current state = {status})"

    # find comment
    comment_to_delete = None
    for comment in device["discussion"]:
        if comment["id"] == comment_id:
            comment_to_delete = comment
            break

    if not comment_to_delete:
        return False, f"Comment {comment_id} could not be deleted as it does not exist for a device {device_id}"

    # project is in a correct state
    # check if the user has permissions for deleting a comment
    allowed_to_delete = False
    allowed_to_delete |= comment_to_delete["author"] == user_id    # comment owner (editor and approver) is always allowed to delete their own comments
    allowed_to_delete |= project["owner"] == user_id   # project owner is always allowed to delete project comments
    if not allowed_to_delete:
        # if user is admin, they should be allowed to delete
        allowed_to_delete |= user_id in get_users_with_privilege(licco_db, "admin")

    if not allowed_to_delete:
        return False, f"You are not allowed to delete comment {comment_id}"

    # remove chosen comment from an array
    updated_comments = [comment for comment in device["discussion"] if not comment["id"] == comment_id]
    licco_db["device_history"].update_one({"_id": ObjectId(device_id)}, {"$set": {"discussion": updated_comments}})
    return True, ""


def create_new_project(licco_db: MongoDb, userid: str, name: str, description: str, editors: List[str], notifier: Notifier) -> Tuple[str, Dict[str, any]]:
    """
    Create a new project belonging to the specified user.
    """
    if name == "":
        return "Project name could not be empty", {}

    if editors:
        # before creating a project we have to validate editors, so that we don't create a project
        # but fail in the update step
        err = validate_editors(licco_db, editors, notifier)
        if err:
            return f"Invalid project editors: {err}", {}
    
    # check if a project with this name already exists
    existing_project = licco_db["projects"].find_one({"name": name})
    if existing_project:
        return f"Project with name {name} already exists", {}

    newprjid = licco_db["projects"].insert_one({
        "name": name, "description": description, "owner": userid, "editors": [], "approvers": [],
        "status": "development", "creation_time": datetime.datetime.now(datetime.UTC)
    }).inserted_id

    if editors:
        ok, err = update_project_details(licco_db, userid, newprjid, {'editors': editors}, notifier)
        if err:
            return err, {}

    create_new_snapshot(licco_db, userid=userid, projectid=newprjid, devices=[])
    prj = get_project(licco_db, newprjid)
    return "", prj


def validate_editors(licco_db: MongoDb, editors: List[str], notifier: Notifier) -> str:
    if not isinstance(editors, list):
        return f"Editors field should be an array"

    # anyone with a SLAC account could be an editor
    invalid_editor_emails = []
    super_approvers = get_users_with_privilege(licco_db, "superapprover")
    for user in editors:
        if user in super_approvers:
            return f"User '{user}' is a super approver and can't be an editor"

        if not notifier.validate_email(user):
            invalid_editor_emails.append(user)

    if invalid_editor_emails:
        invalid_users = ", ".join(invalid_editor_emails)
        return f"Invalid editor emails/accounts: [{invalid_users}]"
    return ""

def change_of_fft_in_project(licco_db: MongoDb, userid: str, prjid: str, fcupdate: Dict[str, any]) -> Tuple[bool, str, str]:
    """
    FC field has changed.

    HISTORY: This used to quite problematic to do in MCD 1.0 (as we had to delete the old device and create a new one),
    but it should be more straightforward now.

    @REFACTOR: I am not sure if this method is even needed right now?
    """
    fftid = fcupdate["_id"]
    if empty_string_or_none(fftid):
        return False, f"Can't change device of a project: fftid should not be empty", ""

    project = get_project(licco_db, prjid)
    if not project:
        return False, f"Project {prjid} does not exist", ""
    if project['status'] != 'development':
        return False, f"Can't change fft {fftid}: Project {project['name']} is not in a development mode (status={project['status']})", ""

    ok, snapshot = get_recent_snapshot(licco_db, prjid=prjid)
    if not ok:
        return ok, f"No data found for project {prjid}", ""

    #change_of_fft = 'fc' in fcupdate
    #if not change_of_fft:
    # this is a regular update, and as such this method was not really used correctly, but it's not a bug
    # since we fallback to the regular fft update
    ok, err, changelog, device_id = update_fft_in_project(licco_db, userid, prjid, fcupdate)
    if not ok:
        return False, err, ""
    new_devices = snapshot["devices"]
    new_devices.remove(ObjectId(fftid))
    new_devices.append(ObjectId(device_id))
    create_new_snapshot(licco_db, userid=userid, projectid=prjid, devices=new_devices, changelog=changelog)
    return ok, err, device_id

def create_new_device(licco_db: MongoDb, userid: str, prjid: str, values: Dict[str, any], modification_time=None,
                      current_project_attributes=None) -> Tuple[bool, str, ObjectId]:

    # if device has "_id" field, we have to remove it, otherwise mongodb will raise a duplicate id exception.
    # When updating an existing device, this _id already exists in mongo (hence we remove it to get a new one)
    values.pop("_id", None)

    if "project_id" not in values:
        values["project_id"] = ObjectId(prjid)
    if "discussion" not in values:
        values["discussion"] = []
    if "state" not in values:
        values["state"] = "Conceptual"
    if not modification_time:
        modification_time = datetime.datetime.now(datetime.UTC)
    values["created"] = modification_time
    dev_id = licco_db["device_history"].insert_one(values).inserted_id
    return True, "", dev_id

def update_fft_in_project(licco_db: MongoDb, userid: str, prjid: str, fcupdate: Dict[str, any], modification_time=None, remove_discussion_comments=None,
                          current_project_attributes=None) -> Tuple[bool, str, List[Dict[str, any]], str]:
    """
    Update the value(s) of an FFT in a project
    Returns: a tuple containing (success flag (true/false if error), error message (if any), and newly created device_id

    @REFACTOR: this method should be refactored
    """

    prj = licco_db["projects"].find_one({"_id": ObjectId(prjid)})
    if not prj:
        return False, f"Cannot find project for {prjid}", [], ''


    if not modification_time:
        modification_time = datetime.datetime.now(datetime.UTC)
    changelog = []

    if ("_id" not in fcupdate):
        ok, err, new_device_id = create_new_device(licco_db, userid, prjid, values=fcupdate, modification_time=modification_time)
        for key in fcupdate:
            changelog.append({
                "_id": '',
                "fc": fcupdate['fc'],
                "prj": prj["name"],
                "key": key,
                "previous": None,
                "val": fcupdate[key],
                "user": userid,
                "time": modification_time
            })
        return ok, err, changelog, str(new_device_id)
    else:
        fftid = fcupdate["_id"]

    current_attrs = current_project_attributes
    if current_attrs is None:
        # NOTE: current_project_attributes should be provided when lots of ffts are updated at the same time, e.g.:
        # for 100 ffts, we shouldn't query the entire project attributes 100 times as that is very slow
        # (cca 150-300 ms per query).
        current_attrs = get_latest_project_data(licco_db, ObjectId(prjid), device_id=fftid)

    # Format the dictionary in the way that we expect   
    if ("fc" in fcupdate) and fcupdate["fc"] in current_attrs:
        current_attrs = current_attrs[fcupdate["fc"]]

    # Make sure the timestamp on this server is monotonically increasing.
    ok, snapshot = get_recent_snapshot(licco_db, prjid)
    if ok:
        # NOTE: not sure if this is the best approach, but when using mongomock for testing
        # we get an error (can't compare offset-naive vs offset aware timestamps), hence we
        # set the timezone info manually.
        time = snapshot["created"]
        if modification_time < time.replace(tzinfo=pytz.utc):
            return False, f"The time on this server {modification_time.isoformat()} is before the most recent change from the server {time.isoformat()}", [], ''

    fft_fields_to_insert = {}

    for attrname, attrval in fcupdate.items():
        if attrname == "_id":
            continue

        # special handling of discussion comments fields
        if attrname == "discussion" and isinstance(attrval, list):
            if remove_discussion_comments:
                continue
            # @REFACTOR: not sure what is the purpose of this?
            old_comments = current_attrs.get(attrname, [])
            new_comments = old_comments
            old_comments = [x['comment'] for x in old_comments]

            for comment in attrval:
                comment_text = comment.get("comment", "")
                if comment_text and comment_text in old_comments:
                    # this comment already exists, hence we don't copy it
                    continue

                author = comment['author']
                newval = comment['comment']
                time = comment.get('time', modification_time)
                new_comments.insert(0, {
                    # each comment needs an uuid, so we can uniquely identify it, if the user decides to delete it
                    "id": str(uuid.uuid4()),
                    "author": author,
                    "comment": newval,
                    "time": time,
                })
            fft_fields_to_insert['discussion'] = new_comments
            continue

        # @TODO: replace field validation with our new device validator
        try:
            attrmeta = FC_ATTRS[attrname]
        except KeyError:
            logger.debug(f"Parameter {attrname} is not in DB. Skipping entry.")
            continue

        try:
            newval = attrmeta["fromstr"](attrval)
        except ValueError:
            # <FFT>, <field>, invalid input rejected: [Wrong type| Out of range]
            error_str = f"Wrong type - {attrname}, ('{attrval}')"
            return False, error_str, [], ''

        prevval = current_attrs.get(attrname, None)

        # Set the FC if it doesn't currently exist-mostly happens on merge/approvals
        if "fc" in current_attrs:
            fc = current_attrs["fc"]
        else:
            fc = fcupdate["fc"]

        if prevval != newval:
            # value has changed
            # append this change to a changelog
            changelog.append({
                "_id": fftid,
                "fc": fc,
                "prj": prj["name"],
                "key": attrname,
                "previous": prevval,
                "val": newval,
                "user": userid,
                "time": modification_time
            })
            fft_fields_to_insert[attrname] = newval

    if fft_fields_to_insert:
        logger.debug(f"Changing {len(changelog)} attributes in device {fftid}")
        current_attrs = {key: value for key, value in current_attrs.items() if key not in ["_id", "created", "projectid", "prjid"]}
        current_attrs.update(fft_fields_to_insert)
        # we should create a new device based on old device
        ok, err, new_device_id = create_new_device(licco_db, userid, prjid, values=current_attrs, modification_time=modification_time)
        return True, "", changelog, str(new_device_id)

    logger.debug("In update_fft_in_project, all_inserts is an empty list")
    return False, "", changelog, ''


# @TODO: @REMOVE it's no longer used
def validate_insert_range(attr, val) -> str:
    """
    Helper function to validate data prior to being saved in DB
    Returns an error in case of invalid range
    """
    try:
        if attr == "ray_trace":
            if val == '' or val is None:
                return ""
            if int(val) < 0:
                return f"invalid range of ray_trace: expected range [0,1], but got {int(val)}"

        # empty strings valid for angles, catch before other verifications
        if "nom" in attr:
            if val == "":
                return ""
            if attr == "nom_loc_z":
                v = float(val)
                if v < 0 or v > 2000:
                    return f"invalid range for {attr}: expected range [0,2000], but got {v}"
            if "nom_ang_" in attr:
                v = float(val)
                if (v < -(math.pi)) or (v > math.pi):
                    return f"invalid range for {attr}: expected range [-{math.pi:.2f}, {math.pi:.2f}], but got {v}"
    except ValueError:
        return f"value {val} is a wrong type for the attribute {attr}"
    except TypeError:
        return f"value {val} is not verified for attribute {attr}"

    # there is no error with this range
    return ""


def update_ffts_in_project(licco_db: MongoDb, userid: str, prjid: str, devices, def_logger=None, remove_discussion_comments=False, ignore_user_permission_check=False) -> Tuple[bool, str, ImportCounter]:
    """
    Insert multiple FFTs into a project
    """
    if def_logger is None:
        def_logger = logger
    insert_counter = ImportCounter()

    if isinstance(devices, dict):
        new_devices = []
        for entry in devices:
            new_devices.append(devices[entry])
        devices = new_devices

    # Get general project details from project table
    project = get_project(licco_db, prjid)
    if project['name'] != MASTER_PROJECT_NAME:
        if project['status'] != 'development':
            return False, f"can't update devices of a project that is not in a development mode (status = {project['status']})", ImportCounter()

    verify_user_permissions = not ignore_user_permission_check
    if verify_user_permissions:
        # check that only owner/editor/admin are allowed to update this project
        allowed_to_update = is_user_allowed_to_edit_project(licco_db, userid, project)
        if not allowed_to_update:
            return False, f"user '{userid}' is not allowed to update a project {project['name']}", ImportCounter()

    # TODO: ROBUSTNESS: we should validate devices before insertion: right now it's possible that only some of the
    #       devices will be inserted, while the ones with errors will not. This leaves the db in an inconsistent state.
    #

    project_devices = get_project_ffts(licco_db, prjid)

    new_ids = []
    changes = []
    # Try to add each device/fft to project
    for dev in devices:
        status, errormsg, changelog, device_id = update_fft_in_project(licco_db, userid, prjid, dev,
                                                           current_project_attributes=project_devices,
                                                           remove_discussion_comments=remove_discussion_comments)
        def_logger.info(f"Import happened for {dev}. ID number {device_id}")

        if status:
            if dev["fc"] in project_devices:
                del project_devices[dev["fc"]]
            changes.append(changelog)
            new_ids.append(device_id)
            insert_counter.success += 1
        else:
            return False, errormsg, ImportCounter()

    for remain_dev in project_devices:
        new_ids.append(project_devices[remain_dev]["_id"])

    create_new_snapshot(licco_db, userid=userid, projectid=prjid, devices=new_ids, changelog=changes)
    return True, "", insert_counter


def create_new_snapshot(licco_db: MongoDb, userid: str, projectid: str, devices: List[str], changelog=None, snapshot_name=None):
    modification_time = datetime.datetime.now(datetime.UTC)
    inserts = {
        "project_id": ObjectId(projectid),
        "author": userid,
        "created": modification_time,
        "devices": [ObjectId(device) for device in devices],
    }

    if changelog:
        inserts["changelog"] = changelog

    if snapshot_name:
        inserts["snapshot_name"] = snapshot_name

    licco_db["project_snapshots"].insert_one(inserts)
    return


def copy_device_values_from_project(licco_db: MongoDb, userid: str, from_prjid: str, to_prjid: str, device_fc: str, attrnames: List[str]) -> Tuple[McdDevice, str]:
    """
    Copy device values from src_prj to dest_prj for the specified attrnames. If attrnames[0] == ALL, then all
    non-metadata fields will be copied over.
    """
    if not attrnames:
        return {}, f"at least one attribute was expected"

    from_device, err = get_device_by_fc_name(licco_db, from_prjid, device_fc)
    if err:
        return {}, f"can't copy a value from a source device: {err}"

    # verify if user has edit permissions for this project
    prj = get_project(licco_db, to_prjid)
    if not prj:
        return {}, f"destination project {to_prjid} was not found"

    if not is_user_allowed_to_edit_project(licco_db, userid, prj):
        prj_name = prj["name"]
        return {}, f"insufficient permission for copying device values to a destination project '{prj_name}'"

    to_device, err = get_device_by_fc_name(licco_db, to_prjid, device_fc)
    if err:
        return {}, f"can't copy a value from a destination device: {err}"

    if attrnames[0] == "ALL":
        # TODO: copy all non-metadata fields from src device
        raise NotImplementedError("'ALL' copy function is not yet supported: please specify all fields manually")
        pass

    # copy chosen device values from source to destination
    # if there is a value that is forbidden to copy (e.g., a metadata field) an error should be raised
    fields_to_copy = set(attrnames)
    if len(fields_to_copy) == 0:
        return {}, f"there are no attribute names to copy"

    found_invalid_keys = []
    invalid_keys = set(common_component_fields.keys())
    for key in invalid_keys:
        if key in fields_to_copy:
            found_invalid_keys.append(key)
    if len(found_invalid_keys) > 0:
        return {}, f"found invalid keys that should not be copied: {found_invalid_keys}"

    # check if fields in attrnames actually exist in both devices?
    changelog = {}
    for key in fields_to_copy:
        if key not in from_device:
            return {}, f"invalid attribute '{key}': attribute does not exist in source device"

        # copy field value from source device
        old_val = to_device.get(key, '')  # it's possible that to_device will not have this field stored in db
        new_val = from_device[key]
        changelog[key] = f"{old_val} -> {new_val}"
        to_device[key] = new_val

    # validate destination device
    err = mcd_validate.validate_device(to_device)
    if err:
        return {}, f"failed to copy values: destination device validation error: {err}"

    # destination device was validated
    # 1. store updated device
    # 2. create a new snapshot
    # 3. return an updated device data
    ok, err, updated_device_id = create_new_device(licco_db, userid, to_prjid, to_device)
    if not ok:
        return {}, f"failed to create an updated device with new values: {err}"

    # create a new snapshot (with updated src device)
    ok, snapshot = get_recent_snapshot(licco_db, from_prjid)
    if not ok:
        return {}, f"failed to create a new project snapshot: snapshot does not exist for {from_prjid}: this should never happen unless someone has just deleted the project"

    updated_devices = [device_id for device_id in snapshot["devices"] if device_id != to_device["_id"]]
    updated_devices.append(updated_device_id)
    create_new_snapshot(licco_db, userid, to_prjid, updated_devices, changelog={device_fc: changelog})

    updated_device = licco_db["device_history"].find_one({"_id": updated_device_id})
    return updated_device, ""


def remove_ffts_from_project(licco_db: MongoDb, userid, prjid, device_ids_to_remove: List[str]) -> Tuple[bool, str]:
    if len(device_ids_to_remove) == 0:
        return True, ""

    editable, errormsg = is_project_editable(licco_db, prjid, userid)
    if not editable:
        return False, errormsg

    ok, snapshot = get_recent_snapshot(licco_db, prjid)
    if not ok:
        return False, f"No data found for project id {prjid}"

    ids = [ObjectId(x) for x in device_ids_to_remove]
    final = list(set(ids) ^ set(snapshot["devices"]))

    licco_db["project_snapshots"].insert_one({
        "project_id": ObjectId(prjid),
        "author": userid,
        "created": datetime.datetime.now(datetime.UTC),
        "devices": final,
        # @TODO: add changelog once we decide how it should look like
    })

    if len(final) == len(snapshot["devices"]):
        # this should never happen when using the GUI (the user can only delete a device if a device is displayed
        # in a GUI (with a valid id) - there should always be at least one such document.
        # Nevertheless, this situation can happen if someone decides to delete a device via a REST API
        # while providing a list of invalid ids.
        #
        # One possibility is also a concurrent delete: user A deletes a device just before user B tries to delete the same device.
        return False, f"Chosen ffts {device_ids_to_remove} do not exist"

    return True, ""

def is_project_editable(db, prjid, userid):
    project = get_project(db, prjid)
    if not project:
        return False, f"Project {prjid} does not exist"
    if project["status"] != "development":
        return False, f"Project {project['name']} is not in a development state"
    user_is_editor = is_user_allowed_to_edit_project(db, userid, project)
    if not user_is_editor:
        return False, f"You are not an editor and therefore can't remove the project devices"
    return True, ""

def _emails_to_usernames(emails: List[str]):
    return [email.split("@")[0] for email in emails]

def submit_project_for_approval(licco_db: MongoDb, project_id: str, userid: str, editors: List[str],
                                approvers: List[str], notifier: Notifier) -> Tuple[bool, str, Optional[McdProject]]:
    """
    Submit a project for approval.
    Set the status to submitted
    """
    prj = licco_db["projects"].find_one({"_id": ObjectId(project_id)})
    project_name = prj["name"]
    if not prj:
        return False, f"Cannot find project for '{project_name}'", None

    status = prj["status"]
    if status != "development" and status != "submitted":
        return False, f"Project '{project_name}' is not in development or submitted status", None

    # check if the user has a permissions for submitting a project
    user_is_allowed_to_edit = is_user_allowed_to_edit_project(licco_db, userid, prj)
    if not user_is_allowed_to_edit:
        return False, f"User {userid} is not allowed to submit a project '{project_name}'", None

    # the list of approvers could be empty, since we automatically add super approvers to this list
    #
    # an approver could be anyone with a SLAC account. These approvers could be given in the
    # form of an email (e.g., username@example.com), which we have to validate
    super_approvers = get_users_with_privilege(licco_db, "superapprover")
    approvers = list(set(approvers).union(super_approvers))
    approvers.sort()

    # validate a list of approvers
    if len(approvers) == 0:
        return False, f"Project '{project_name}' should have at least 1 approver", None
    for a in approvers:
        if not a:
            return False, f"Invalid project approver: '{a}'", None
    if userid in approvers:
        return False, f"Submitter {userid} is not allowed to also be a project approver", None
    if prj["owner"] in approvers:
        return False, f"A project owner {userid} is not allowed to also be a project approver", None

    # check if approver is also an editor (they are not allowed to be)
    approver_usernames = _emails_to_usernames(approvers)
    editor_usernames = _emails_to_usernames(editors)
    users_with_multiple_roles = []
    for i, approver in enumerate(approver_usernames):
        if approver in editor_usernames:
            # we want to return the name of the approver with the actual name that the user had sent us
            # otherwise the error message may look confusing (e.g., the user sent us 'user@example.com'
            # we return the same string back within the error message)
            users_with_multiple_roles.append(approvers[i])
    if users_with_multiple_roles:
        multiple_roles = ", ".join(users_with_multiple_roles)
        return False, f"The users are not allowed to be both editors and approvers: [{multiple_roles}]", None

    invalid_approver_accounts = []
    for a in approvers:
        if not notifier.validate_email(a):
            invalid_approver_accounts.append(a)

    if invalid_approver_accounts:
        invalid_accounts = ", ".join(invalid_approver_accounts)
        return False, f"Invalid approver emails/accounts: [{invalid_accounts}]", None

    # update editors (if necessary)
    editors_update_ok, err = update_project_details(licco_db, userid, project_id, {'editors': editors}, notifier)
    if not editors_update_ok:
        return editors_update_ok, err, None

    # store approval metadata
    # all approvers are valid, but we have to store their usernames since the application performs permission checks
    # via usernames (and not emails that the user may provide)
    licco_db["projects"].update_one({"_id": prj["_id"]}, {"$set": {
        "status": "submitted", "submitter": userid, "approvers": approver_usernames,
        "submitted_time": datetime.datetime.now(datetime.UTC)
    }})

    # send notifications (to the right approvers and project editors)
    old_approvers = prj.get("approvers", [])
    update_diff = diff_arrays(old_approvers, approvers)
    superapp_diff = diff_arrays(super_approvers, approvers)

    deleted_approvers = update_diff.removed
    if deleted_approvers:
        notifier.remove_project_approvers(deleted_approvers, project_name, project_id)

    if prj["status"] == "development":
        # project was submitted for the first time
        project_editors = list(set([prj["owner"]] + editors))
        # inform all editors, super approvers, and approvers
        notifier.project_submitted_for_approval(project_editors, project_name, project_id)
        notifier.add_project_superapprovers(list(superapp_diff.in_both), project_name, project_id)
        notifier.add_project_approvers(list(superapp_diff.new), project_name, project_id)

    else:
        # project was edited
        if update_diff.new:
            # update any new approvers
            notifier.add_project_approvers(list(update_diff.new), project_name, project_id)
        project_editors = list(set([prj["owner"]] + editors))
        approvers_have_changed = update_diff.new or deleted_approvers
        if approvers_have_changed:
            notifier.inform_editors_of_approver_change(project_editors, project_name, project_id, approvers)

    project = licco_db["projects"].find_one({"_id": ObjectId(project_id)})
    return True, "", project


def approve_project(licco_db: MongoDb, prjid: str, userid: str, notifier: Notifier) -> Tuple[bool, bool, str, Dict[str, any]]:
    """
    Approve a submitted project.
    Set the status to approved
    """
    prj = licco_db["projects"].find_one({"_id": ObjectId(prjid)})
    if not prj:
        return False, False, f"Cannot find project for {prjid}", {}
    if prj["status"] != "submitted":
        return False, False, f"Project {prjid} is not in submitted status", {}
    if prj["submitter"] == userid:
        return False, False, f"Project {prj['name']} cannot be approved by its submitter {userid}. Please ask someone other than the submitter to approve the project", {}

    assigned_approvers = prj.get("approvers", [])
    if userid not in assigned_approvers:
        # super approvers are stored as project approvers so we don't have an extra check just for them
        return False, False, f"User {userid} is not allowed to approve the project", {}

    # update the project metadata
    approved_by = prj.get("approved_by", [])
    if userid in approved_by:
        return False, False, f"User {userid} has already approved this project", {}

    approved_by = [userid] + approved_by
    updated_project_data = {
        "approved_by": approved_by
    }

    # user was allowed to approve, store the approvers for this project
    licco_db["projects"].update_one({"_id": prj["_id"]}, {"$set": updated_project_data})

    all_assigned_approvers_approved = set(assigned_approvers).issubset(set(approved_by))
    still_waiting_for_approval = not all_assigned_approvers_approved
    if still_waiting_for_approval:
        updated_project = get_project(licco_db, prj["_id"])
        return True, all_assigned_approvers_approved, "", updated_project

    # all assigned approvers have approved the project
    # now we merge the data changes into the master project and update the merged project's metadata

    # update fft data of master project
    master_project = licco_db["projects"].find_one({"name": MASTER_PROJECT_NAME})
    if not master_project:
        return False, False, "Failed to find an approved project: this is a programming bug", {}
    licco_db["projects"].update_one({"_id": master_project["_id"]}, {"$set": {
        "owner": "", "status": "approved", "approved_time": datetime.datetime.now(datetime.UTC)
    }})

    # master project should not inherit old discussion comments from a submitted project, hence the removal flag
    status, errormsg, update_status = update_ffts_in_project(licco_db, userid,
                                                             master_project["_id"],
                                                             get_project_ffts(licco_db, prjid),
                                                             remove_discussion_comments=True,
                                                             ignore_user_permission_check=True)
    if not status:
        # failed to insert changed fft data into master project
        return False, False, errormsg, {}

    store_project_approval(licco_db, prjid, prj["submitter"])

    # successfully inserted project ffts into a master project
    # send notifications that the project was approved
    project_name = prj["name"]
    notified_users = list(set([(prj["owner"])] + prj["editors"] + prj["approvers"]))
    notifier.project_approval_approved(notified_users, project_name, prjid)

    # once the project is approved and fully merged in, it goes back into the development status
    # we have only 1 approved project at a time, to which the ffts are copied
    updated_project_data["status"] = "development"
    updated_project_data['approved_time'] = datetime.datetime.now(datetime.UTC)
    # clean the project metadata as if it was freshly created project
    updated_project_data["editors"] = []
    updated_project_data["approvers"] = []
    updated_project_data["approved_by"] = []
    updated_project_data['notes'] = []
    licco_db["projects"].update_one({"_id": prj["_id"]}, {"$set": updated_project_data})
    updated_project = get_project(licco_db, prj["_id"])

    return True, all_assigned_approvers_approved, "", updated_project


def reject_project(licco_db: MongoDb, prjid: str, userid: str, reason: str, notifier: Notifier):
    """
    Do not approve a submitted project.
    Set the status to development
    """
    prj = licco_db["projects"].find_one({"_id": ObjectId(prjid)})
    if not prj:
        return False, f"Cannot find project for {prjid}", None
    if prj["status"] != "submitted":
        return False, f"Project {prjid} is not in submitted status", None

    allowed_to_reject = False
    allowed_to_reject |= userid == prj['owner']
    allowed_to_reject |= userid in prj['editors']
    allowed_to_reject |= userid in prj['approvers']
    if not allowed_to_reject and userid in get_users_with_privilege(licco_db, "admin"):
        # user is admin, and as such has the privilege to delete a project
        allowed_to_reject = True

    if not allowed_to_reject:
        return False, f"User {userid} is not allowed to reject this project", None

    # TODO: notes should probably be stored in a format (user: <username>, date: datetime, content: "")
    # so we can avoid rendering them when they are no longer relevant.
    now = datetime.datetime.now(datetime.UTC)
    licco_datetime = now.strftime("%b/%d/%Y %H:%M:%S")
    formatted_reason = f"{userid} ({licco_datetime}):\n{reason}"
    licco_db["projects"].update_one({"_id": prj["_id"]}, {"$set": {
                                                        "status": "development",
                                                        "approved_by": [],
                                                        "approved_time": None,
                                                        "notes": [formatted_reason] + prj.get("notes", [])}})
    updated_project = licco_db["projects"].find_one({"_id": ObjectId(prjid)})

    # send notifications
    project_id = updated_project["_id"]
    project_name = updated_project["name"]
    owner = updated_project["owner"]
    editors = updated_project["editors"]
    approvers = updated_project["approvers"]
    project_approver_emails = list(set([owner] + editors + approvers))
    user_who_rejected = userid
    notifier.project_approval_rejected(project_approver_emails, project_name, project_id,
                                               user_who_rejected, reason)
    return True, "", updated_project


def get_master_project(licco_db: MongoDb):
    """
    Get the current approved project by status
    """
    prj = licco_db["projects"].find_one({"name": MASTER_PROJECT_NAME})
    if prj and prj["status"] == "approved":
        return prj
    return None


def store_project_approval(licco_db: MongoDb, prjid: str, project_submitter: str):
    licco_db["switch"].insert_one({
        "prj": ObjectId(prjid),
        "requestor_uid": project_submitter,
        "switch_time": datetime.datetime.now(datetime.UTC)
    })


def get_projects_approval_history(licco_db: MongoDb, limit: int = 100):
    """
    Get the history of project approvals
    """
    hist = list(licco_db["switch"].aggregate([
        {"$sort": {"switch_time": -1}},
        {"$limit": limit},
        {"$lookup": {"from": "projects", "localField": "prj",
                     "foreignField": "_id", "as": "prjobj"}},
        {"$unwind": "$prjobj"},
        {"$project": {
            "_id": "$_id",
            "switch_time": "$switch_time",
            "requestor_uid": "$requestor_uid",
            "prj": "$prjobj.name",
            "description": "$prjobj.description",
            "owner": "$prjobj.owner"
        }}
    ]))
    return hist


def get_all_projects_last_edit_time(licco_db: MongoDb) -> Dict[str, Dict[str, datetime.datetime | str]]:
    """
    Gets the most recent time of edit for all projects in development status
    """
    edit_list = {}
    projects = licco_db["projects"].find()
    for project in projects:
        prjid = str(project["_id"])
        last_edit_time = get_project_last_edit_time(licco_db, prjid)
        if last_edit_time:
            edit_list[prjid] = {"_id": prjid, "time": last_edit_time}
        else:
            edit_list[prjid] = {"_id": "", "time": ""}
    return edit_list


def get_project_last_edit_time(licco_db: MongoDb, project_id: str) -> Optional[datetime.datetime]:
    ok, snapshot = get_recent_snapshot(licco_db, project_id)
    if not ok:
        return None
    return snapshot["created"]


def __flatten__(obj, prefix=""):
    """
    Flatten a dict into a list of key value pairs using dot notation.
    """
    ret = []
    if isinstance(obj, Mapping):
        for k, v in obj.items():
            ret.extend(__flatten__(v, prefix + "." + k if prefix else k))
    elif isinstance(obj, list):
        for c, e in enumerate(obj):
            ret.extend(__flatten__(
                e, prefix + ".[" + str(c) + "]" if prefix else "[" + str(c) + "]"))
    else:
        ret.append((prefix, obj))
    return ret


def clone_project(licco_db: MongoDb, userid: str, prjid: str, name: str, description: str, editors: List[str], notifier: Notifier):
    """
    Clone the existing project specified by prjid as a new project with the name and description.
    """
    super_approvers = get_users_with_privilege(licco_db, "superapprover")
    if userid in super_approvers:
        # super approvers should not be editors or owner of projects
        return False, f"Super approver is not allowed to clone the project", None

    if editors:
        for e in editors:
            if e in super_approvers:
                return False, f"Selected editor {e} is also a super approver: super approvers are not allowed to be project editors", None

    # check if a project with this name already exists
    existing_project = licco_db["projects"].find_one({"name": name})
    if existing_project:
        return False, f"Project with name {name} already exists", None

    err, created_project = create_new_project(licco_db, userid, name, description, [], notifier)
    if err:
        return False, f"Failed to create a new project: {err}", None

    # we are cloning an existing project
    ok, original_project = get_recent_snapshot(licco_db, prjid)
    if not ok:
        return False, f"Project {prjid} to clone from is not found, or has no values to copy", None

    # @TODO: we should probably make a deep copy, otherwise the comment threads will be shared between original and
    # a new project...
    create_new_snapshot(licco_db, projectid=created_project["_id"], devices=original_project["devices"], userid=userid)

    if editors:
        status, err = update_project_details(licco_db, userid, created_project["_id"], {'editors': editors}, notifier)
        if not status:
            # there was an error while updating editors
            # see the explanation above why we still return success (True).
            logger.error(f"Failed to update editors of a new project {prjid}: {err}")
            return True, "", created_project

    # load the project together with editors
    created_project = get_project(licco_db, created_project["_id"])
    return True, "", created_project


def update_project_details(licco_db: MongoDb, userid: str, prjid: str, user_changes: Dict[str, any], notifier: Notifier) -> Tuple[bool, str]:
    """
    Just update the project name ands description
    """
    project = get_project(licco_db, prjid)
    project_owner = project["owner"]
    user_has_permission_to_edit = project_owner == userid or userid in project["editors"]
    if not user_has_permission_to_edit:
        name = project["name"]
        return False, f"You have no permissions to edit a project '{name}'"

    if len(user_changes) == 0:
        return False, f"Project update should not be empty"

    update = {}
    for key, val in user_changes.items():
        if key == "name":
            if not val:
                return False, f"Name cannot be empty"
            update["name"] = val
        elif key == "description":
            if not val:
                return False, f"Description cannot be empty"
            update["description"] = val
        elif key == "editors":
            editors = val
            err = validate_editors(licco_db, editors, notifier)
            if err:
                return False, err

            # all users are valid (or editor's list is empty)
            # For now we only store the usernames in the editors list, since permission
            # comparison is done by comparing usernames as well. This behavior might change
            # in the future to accomodate any email (even from outside of organization)
            updated_editors = _emails_to_usernames(editors)
            update["editors"] = updated_editors
        else:
            return False, f"Invalid update field '{key}'"

    licco_db["projects"].update_one({"_id": ObjectId(prjid)}, {"$set": update})

    # send notifications if necessary
    updated_editors = "editors" in user_changes
    if notifier and updated_editors:
        old_editors = project["editors"]
        updated_editors = update["editors"]
        diff = diff_arrays(old_editors, updated_editors)

        removed_editors = diff.removed
        new_editors = diff.new
        project_name = project["name"]
        project_id = project["_id"]
        if new_editors:
            notifier.add_project_editors(new_editors, project_name, project_id)
        if removed_editors:
            notifier.remove_project_editors(removed_editors, project_name, project_id)

    return True, ""


def delete_project(licco_db: MongoDb, userid, project_id):
    """
    Delete the chosen project and all related data (history of value changes, tags).
    """
    prj = get_project(licco_db, project_id)
    if not prj:
        return False, f"Project {project_id} does not exist"

    admins = get_users_with_privilege(licco_db, "admin")
    user_is_owner = userid == prj["owner"]
    user_is_admin = userid in admins

    allowed_to_delete = user_is_owner or user_is_admin
    if not allowed_to_delete:
        return False, f"You don't have permissions to delete the project {prj['name']}"

    if user_is_admin:
        # deletion for admin role means 'delete'
        licco_db["projects"].delete_one({'_id': ObjectId(project_id)})
        licco_db["project_snapshots"].delete_many({'project_id': ObjectId(project_id)})
        licco_db["tags"].delete_many({'prj': ObjectId(project_id)})
        return True, ""

    new_project_name = 'hidden' + '_' + prj['name'] + '_'+ datetime.date.today().strftime('%m/%d/%Y')
    # user is just the owner, delete in this case means 'hide the project'
    licco_db["projects"].update_one({'_id': ObjectId(project_id)}, {'$set': {'status': 'hidden', 'name': new_project_name}})
    return True, ""


def get_tags_for_project(licco_db: MongoDb, prjid):
    """
    Get the tags for the specified project
    """
    prj = licco_db["projects"].find_one({"_id": ObjectId(prjid)})
    if not prj:
        return False, f"Cannot find project for {prjid}", None
    tags = list(licco_db["tags"].find({"prj": ObjectId(prjid)}))
    return True, "", tags


def add_project_tag(licco_db: MongoDb, prjid, tagname, asoftimestamp):
    """
    Add a tag at the specified time for the project.
    """
    prj = licco_db["projects"].find_one({"_id": ObjectId(prjid)})
    if not prj:
        return False, f"Cannot find project for {prjid}", None

    existing_tag = licco_db["tags"].find_one({"name": tagname, "prj": ObjectId(prjid)})
    if existing_tag:
        return False, f"Tag {tagname} already exists for project {prjid}", None

    licco_db["tags"].insert_one({"prj": ObjectId(prjid), "name": tagname, "time": asoftimestamp})
    tags = list(licco_db["tags"].find({"prj": ObjectId(prjid)}))
    return True, "", tags
